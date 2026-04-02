// =============================================================================
// backend-max — Database migration auditor
//
// Audits migration files for destructive operations, missing rollbacks,
// schema drift, and migration ordering issues.
// Supports: Prisma, Knex, Drizzle, and raw SQL migrations.
// =============================================================================

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "glob";
import type { Issue, IssueCategory } from "../types.js";
import { generateIssueId } from "../utils/helpers.js";

const CATEGORY: IssueCategory = "prisma";

// ---------------------------------------------------------------------------
// Destructive SQL patterns
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS = [
  { regex: /DROP\s+TABLE/gi,         name: "DROP TABLE",        risk: "Permanently deletes table and all data" },
  { regex: /DROP\s+COLUMN/gi,        name: "DROP COLUMN",       risk: "Permanently deletes column data" },
  { regex: /ALTER\s+TABLE\s+\w+\s+DROP/gi, name: "ALTER DROP",  risk: "Removes column or constraint" },
  { regex: /TRUNCATE/gi,             name: "TRUNCATE",          risk: "Deletes all rows from table" },
  { regex: /DROP\s+INDEX/gi,         name: "DROP INDEX",        risk: "Removes index (may impact query performance)" },
  { regex: /DROP\s+DATABASE/gi,      name: "DROP DATABASE",     risk: "Drops entire database" },
  { regex: /ALTER\s+.*\s+TYPE\b/gi,  name: "ALTER TYPE",        risk: "Changes column type — may cause data loss or truncation" },
  { regex: /NOT\s+NULL/gi,           name: "NOT NULL constraint", risk: "Adding NOT NULL to existing column fails if NULLs exist" },
  { regex: /ALTER\s+.*\s+RENAME/gi,  name: "RENAME",            risk: "Renames column/table — breaks existing queries" },
];

// ---------------------------------------------------------------------------
// Migration discovery patterns
// ---------------------------------------------------------------------------

const MIGRATION_DIRS = [
  "prisma/migrations",
  "migrations",
  "db/migrations",
  "src/db/migrations",
  "drizzle",
  "src/drizzle",
  "knex/migrations",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MigrationFile {
  path: string;
  relPath: string;
  name: string;
  content: string;
  timestamp: string | null;
  hasDown: boolean;
  destructiveOps: string[];
}

export interface MigrationAuditResult {
  issues: Issue[];
  migrations: Array<{
    file: string;
    hasDown: boolean;
    destructiveOps: string[];
    linesOfSql: number;
  }>;
  summary: {
    totalMigrations: number;
    destructiveMigrations: number;
    missingRollbacks: number;
    ormDetected: string | null;
    migrationDir: string | null;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function auditMigrations(projectPath: string): Promise<MigrationAuditResult> {
  const issues: Issue[] = [];
  const migrationFiles: MigrationFile[] = [];
  let ormDetected: string | null = null;
  let migrationDir: string | null = null;

  // Detect ORM from package.json
  try {
    const pkg = JSON.parse(await readFile(join(projectPath, "package.json"), "utf-8"));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ("prisma" in allDeps || "@prisma/client" in allDeps) ormDetected = "prisma";
    else if ("drizzle-orm" in allDeps) ormDetected = "drizzle";
    else if ("knex" in allDeps) ormDetected = "knex";
    else if ("typeorm" in allDeps) ormDetected = "typeorm";
    else if ("sequelize" in allDeps) ormDetected = "sequelize";
  } catch { /* no package.json */ }

  // Find migration directory
  for (const dir of MIGRATION_DIRS) {
    const fullPath = join(projectPath, dir);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        migrationDir = dir;
        break;
      }
    } catch { /* doesn't exist */ }
  }

  if (!migrationDir) {
    // No migrations found — check if ORM is present without migrations
    if (ormDetected) {
      issues.push({
        id: generateIssueId(CATEGORY, projectPath, "no-migrations-dir"),
        category: CATEGORY,
        severity: "info",
        title: `${ormDetected} detected but no migration directory found`,
        description:
          `${ormDetected} is installed but no migration directory was found. ` +
          `If using ${ormDetected}, run the migration generator to create initial migrations.`,
        file: "package.json",
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }

    return {
      issues,
      migrations: [],
      summary: {
        totalMigrations: 0,
        destructiveMigrations: 0,
        missingRollbacks: 0,
        ormDetected,
        migrationDir: null,
      },
    };
  }

  // Scan migration files
  const migFiles = await glob("**/*.{sql,ts,js}", {
    cwd: join(projectPath, migrationDir),
    absolute: true,
    nodir: true,
    ignore: ["node_modules/**"],
  });

  for (const filePath of migFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch { continue; }

    const relPath = relative(projectPath, filePath);
    const name = relative(join(projectPath, migrationDir), filePath);

    // Extract timestamp from filename/directory
    const timestampMatch = name.match(/(\d{4}[\d_-]+)/);
    const timestamp = timestampMatch ? timestampMatch[1] : null;

    // Check for rollback / down migration
    const hasDown =
      content.includes("exports.down") ||
      content.includes("export async function down") ||
      content.includes(".down(") ||
      name.includes("down") ||
      content.includes("-- Down") ||
      content.includes("-- Rollback");

    // Check for destructive operations
    const destructiveOps: string[] = [];
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(content)) {
        destructiveOps.push(pattern.name);
      }
    }

    migrationFiles.push({
      path: filePath,
      relPath,
      name,
      content,
      timestamp,
      hasDown,
      destructiveOps,
    });
  }

  // Sort by timestamp
  migrationFiles.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  let destructiveMigrations = 0;
  let missingRollbacks = 0;

  // Analyze each migration
  for (const mf of migrationFiles) {
    // Flag destructive operations
    if (mf.destructiveOps.length > 0) {
      destructiveMigrations++;

      for (const op of mf.destructiveOps) {
        const pattern = DESTRUCTIVE_PATTERNS.find((p) => p.name === op);
        issues.push({
          id: generateIssueId(CATEGORY, mf.relPath, op),
          category: CATEGORY,
          severity: "warning",
          title: `Destructive operation: ${op} in ${mf.name}`,
          description:
            `Migration ${mf.name} contains ${op}. ${pattern?.risk ?? "This may cause data loss."}. ` +
            `Ensure this is intentional and data has been backed up before running in production.`,
          file: mf.relPath,
          line: findLineNumber(mf.content, new RegExp(op.replace(/\s+/g, "\\s+"), "i")),
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }

      // Destructive migrations without rollback are extra risky
      if (!mf.hasDown) {
        issues.push({
          id: generateIssueId(CATEGORY, mf.relPath, "destructive-no-rollback"),
          category: CATEGORY,
          severity: "critical",
          title: `Destructive migration without rollback: ${mf.name}`,
          description:
            `Migration ${mf.name} contains destructive operations (${mf.destructiveOps.join(", ")}) ` +
            `but has no down/rollback migration. If this migration fails partway through, ` +
            `there is no automated way to recover.`,
          file: mf.relPath,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }

    // Flag missing rollbacks (for non-Prisma ORMs — Prisma doesn't use down migrations)
    if (!mf.hasDown && ormDetected !== "prisma") {
      // Only flag .ts/.js migrations (SQL-only might be Prisma auto-generated)
      if (mf.name.endsWith(".ts") || mf.name.endsWith(".js")) {
        missingRollbacks++;
        issues.push({
          id: generateIssueId(CATEGORY, mf.relPath, "no-rollback"),
          category: CATEGORY,
          severity: "info",
          title: `Missing rollback/down migration: ${mf.name}`,
          description:
            `Migration ${mf.name} has no down() or rollback function. ` +
            `Consider adding one to enable safe rollbacks in case of issues.`,
          file: mf.relPath,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }
  }

  // Check for Prisma schema drift (if Prisma)
  if (ormDetected === "prisma") {
    try {
      const schemaPath = join(projectPath, "prisma", "schema.prisma");
      const schema = await readFile(schemaPath, "utf-8");

      // Count models in schema vs tables created in migrations
      const schemaModels = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
      const migrationTables = new Set<string>();
      for (const mf of migrationFiles) {
        for (const match of mf.content.matchAll(/CREATE TABLE\s+["'`]?(\w+)["'`]?/gi)) {
          migrationTables.add(match[1]);
        }
      }

      // Check for models that have no corresponding migration
      for (const model of schemaModels) {
        const tableName = model.toLowerCase();
        const variants = [tableName, `${tableName}s`, `_${tableName}`, model, `${model}s`];
        const found = variants.some((v) => migrationTables.has(v) || migrationTables.has(`_prisma_migrations`));
        if (!found && migrationTables.size > 0) {
          issues.push({
            id: generateIssueId(CATEGORY, "prisma/schema.prisma", `drift-${model}`),
            category: CATEGORY,
            severity: "info",
            title: `Possible schema drift: model ${model}`,
            description:
              `Prisma model "${model}" exists in schema.prisma but no matching CREATE TABLE ` +
              `was found in migration files. Run \`npx prisma migrate dev\` to generate the migration.`,
            file: "prisma/schema.prisma",
            line: findLineNumber(schema, new RegExp(`model\\s+${model}`)),
            status: "open",
            firstSeen: new Date().toISOString(),
            fixedAt: null,
          });
        }
      }
    } catch { /* schema not found */ }
  }

  return {
    issues,
    migrations: migrationFiles.map((mf) => ({
      file: mf.relPath,
      hasDown: mf.hasDown,
      destructiveOps: mf.destructiveOps,
      linesOfSql: mf.content.split("\n").length,
    })),
    summary: {
      totalMigrations: migrationFiles.length,
      destructiveMigrations,
      missingRollbacks,
      ormDetected,
      migrationDir,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLineNumber(content: string, pattern: RegExp): number | null {
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;
  return content.slice(0, match.index).split("\n").length;
}
