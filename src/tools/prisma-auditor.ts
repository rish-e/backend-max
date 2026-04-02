// =============================================================================
// backend-max — Prisma Auditor
//
// Orchestrates Prisma schema analysis: parses the schema, scans source files
// for database calls, cross-references them, and checks for migration drift.
// =============================================================================

import { glob } from "glob";
import {
  crossReferenceCalls,
  detectMigrationDrift,
  parsePrismaSchema,
} from "../analyzers/prisma.js";
import { createProject } from "../analyzers/typescript.js";
import type { DatabaseCall, Issue, IssueCategory, PrismaSchemaInfo, Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_PATTERNS = [
  "app/**/route.{ts,tsx,js,jsx}",
  "src/app/**/route.{ts,tsx,js,jsx}",
  "pages/api/**/*.{ts,tsx,js,jsx}",
  "src/pages/api/**/*.{ts,tsx,js,jsx}",
  "src/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "server/**/*.{ts,tsx}",
];

const IGNORE_DIRS = ["node_modules/**", ".next/**", "dist/**", "build/**", ".git/**"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audits Prisma schema and database usage across the project.
 *
 * Steps:
 * 1. Parse the Prisma schema file
 * 2. Scan all route/source files for Prisma database calls
 * 3. Cross-reference calls against the schema
 * 4. Check for migration drift
 * 5. Return combined issues
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Issues, schema info, and a summary.
 */
export async function auditPrisma(projectPath: string): Promise<{
  issues: Issue[];
  schema: PrismaSchemaInfo | null;
  summary: { models: number; enums: number; issues: number };
}> {
  const issues: Issue[] = [];

  // 1. Parse schema
  let schema: PrismaSchemaInfo | null = null;
  try {
    schema = await parsePrismaSchema(projectPath);
  } catch (error) {
    issues.push(
      makeIssue(
        "PRISMA-PARSE-1",
        "prisma",
        "warning",
        "Failed to parse Prisma schema",
        `Could not parse schema.prisma: ${error instanceof Error ? error.message : String(error)}`,
        projectPath,
        null,
      ),
    );
  }

  if (!schema) {
    return {
      issues,
      schema: null,
      summary: { models: 0, enums: 0, issues: issues.length },
    };
  }

  // 2. Scan source files for Prisma calls
  const dbCalls = await extractDatabaseCallsFromProject(projectPath);

  // 3. Cross-reference calls against schema
  try {
    const prismaIssues = crossReferenceCalls(schema, dbCalls);
    for (const pi of prismaIssues) {
      const severity: Severity =
        pi.type === "nonexistent-model"
          ? "critical"
          : pi.type === "nonexistent-field"
            ? "bug"
            : "info";

      issues.push(
        makeIssue(
          `PRISMA-${pi.type.toUpperCase()}-${issues.length + 1}`,
          "prisma",
          severity,
          `Prisma: ${pi.type.replace(/-/g, " ")} — ${pi.model}${pi.field ? `.${pi.field}` : ""}`,
          pi.description,
          pi.file,
          pi.line || null,
        ),
      );
    }
  } catch {
    // Cross-reference failure is non-fatal
  }

  // 4. Check for migration drift
  try {
    const migrationIssues = await detectMigrationDrift(projectPath);
    for (const mi of migrationIssues) {
      const severity: Severity = mi.type === "drift-suspected" ? "warning" : "info";

      issues.push(
        makeIssue(
          `PRISMA-MIG-${issues.length + 1}`,
          "prisma",
          severity,
          `Prisma migration: ${mi.type.replace(/-/g, " ")}`,
          mi.description,
          projectPath,
          null,
        ),
      );
    }
  } catch {
    // Migration drift check is non-fatal
  }

  return {
    issues,
    schema,
    summary: {
      models: schema.models.length,
      enums: schema.enums.length,
      issues: issues.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Database call extraction
// ---------------------------------------------------------------------------

/**
 * Scans project source files and extracts structured Prisma database calls.
 *
 * For each `prisma.model.operation(...)` call, extracts the model name,
 * operation, and any fields referenced in where/select/include clauses.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Array of structured DatabaseCall objects.
 */
async function extractDatabaseCallsFromProject(projectPath: string): Promise<DatabaseCall[]> {
  const calls: DatabaseCall[] = [];

  // Discover source files
  const files: string[] = [];
  for (const pattern of SOURCE_PATTERNS) {
    const matches = await glob(pattern, {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: IGNORE_DIRS,
    });
    files.push(...matches);
  }

  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0) {
    return calls;
  }

  const project = createProject(projectPath);

  for (const filePath of uniqueFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const text = sourceFile.getText();

      // Match prisma.model.operation patterns
      const prismaCallRegex = /prisma\.(\w+)\.(\w+)\s*\(([^)]*(?:\{[^}]*\}[^)]*)?)\)/gs;

      let match: RegExpExecArray | null;
      while ((match = prismaCallRegex.exec(text)) !== null) {
        const model = match[1];
        const operation = match[2];
        const argsText = match[3];
        const lineNum = text.slice(0, match.index).split("\n").length;

        // Skip raw/internal calls like prisma.$queryRaw
        if (model.startsWith("$")) continue;

        // Extract field names from where, select, include clauses
        const fields = extractFieldsFromArgs(argsText);

        calls.push({
          model,
          operation,
          fields,
          file: filePath,
          line: lineNum,
        });
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return calls;
}

/**
 * Extracts field names from Prisma call arguments (where, select, include).
 *
 * Parses patterns like `{ where: { email: ... }, select: { name: true } }`
 * to extract ["email", "name"].
 */
function extractFieldsFromArgs(argsText: string): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();

  // Match keys in object literals: `fieldName:` or `fieldName :`
  const fieldRegex = /(\w+)\s*:/g;

  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(argsText)) !== null) {
    const fieldName = match[1];
    // Filter out Prisma keywords
    const keywords = new Set([
      "where",
      "select",
      "include",
      "data",
      "orderBy",
      "take",
      "skip",
      "cursor",
      "distinct",
      "create",
      "update",
      "connectOrCreate",
      "connect",
      "disconnect",
      "set",
      "true",
      "false",
      "equals",
      "not",
      "in",
      "notIn",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "startsWith",
      "endsWith",
      "mode",
      "AND",
      "OR",
      "NOT",
      "some",
      "every",
      "none",
      "is",
      "isNot",
      "has",
      "hasEvery",
      "hasSome",
      "isEmpty",
    ]);

    if (!keywords.has(fieldName) && !seen.has(fieldName)) {
      seen.add(fieldName);
      fields.push(fieldName);
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Issue factory
// ---------------------------------------------------------------------------

/**
 * Creates a standardized Issue object.
 */
function makeIssue(
  id: string,
  category: IssueCategory,
  severity: Severity,
  title: string,
  description: string,
  file: string,
  line: number | null,
): Issue {
  return {
    id,
    category,
    severity,
    title,
    description,
    file,
    line,
    status: "open",
    firstSeen: new Date().toISOString(),
    fixedAt: null,
  };
}
