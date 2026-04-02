// =============================================================================
// backend-max — Prisma schema parser and cross-reference analyzer
// =============================================================================

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  DatabaseCall,
  MigrationIssue,
  PrismaEnum,
  PrismaField,
  PrismaIssue,
  PrismaModel,
  PrismaSchemaInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Schema file discovery
// ---------------------------------------------------------------------------

/** Possible locations for the Prisma schema file. */
const SCHEMA_LOCATIONS = ["prisma/schema.prisma", "src/prisma/schema.prisma", "schema.prisma"];

/**
 * Finds the Prisma schema file in a project directory.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Absolute path to schema.prisma, or null if not found.
 */
function findSchemaFile(projectPath: string): string | null {
  for (const location of SCHEMA_LOCATIONS) {
    const fullPath = join(projectPath, location);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

/**
 * Parses a Prisma schema file and extracts model, field, and enum information.
 *
 * Uses regex-based parsing to avoid depending on heavy/unstable Prisma internals.
 * Handles model blocks, field definitions with modifiers, enums, and index directives.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Parsed PrismaSchemaInfo, or null if no schema file is found.
 */
export async function parsePrismaSchema(projectPath: string): Promise<PrismaSchemaInfo | null> {
  const schemaPath = findSchemaFile(projectPath);
  if (!schemaPath) {
    return null;
  }

  let content: string;
  try {
    content = await readFile(schemaPath, "utf-8");
  } catch {
    /* skip: unreadable schema file */
    return null;
  }

  const models = parseModels(content);
  const enums = parseEnums(content);

  return {
    models,
    enums,
    filePath: schemaPath,
  };
}

/**
 * Parses all model blocks from the schema content.
 */
function parseModels(content: string): PrismaModel[] {
  const models: PrismaModel[] = [];
  const modelRegex = /model\s+(\w+)\s*\{([^}]*)\}/gs;

  let match: RegExpExecArray | null;
  while ((match = modelRegex.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];

    const fields = parseFields(body);
    const indexes = parseDirective(body, "@@index");
    const uniqueConstraints = parseDirective(body, "@@unique");

    models.push({ name, fields, indexes, uniqueConstraints });
  }

  return models;
}

/**
 * Parses field definitions from a model body.
 *
 * A Prisma field line looks like:
 *   id        Int      @id @default(autoincrement())
 *   email     String   @unique
 *   name      String?
 *   posts     Post[]
 *   author    User     @relation(fields: [authorId], references: [id])
 */
function parseFields(body: string): PrismaField[] {
  const fields: PrismaField[] = [];
  const lines = body.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines, comments, and directives (@@index, @@unique, @@map, etc.)
    if (!line || line.startsWith("//") || line.startsWith("@@")) {
      continue;
    }

    // A field line must start with an identifier, followed by a type
    const fieldMatch = line.match(/^(\w+)\s+([\w]+)(\[\])?\s*(\?)?\s*(.*)?$/);
    if (!fieldMatch) {
      continue;
    }

    const [, fieldName, fieldType, isList, isOptional, modifiers] = fieldMatch;
    const modStr = modifiers ?? "";

    fields.push({
      name: fieldName,
      type: fieldType,
      isRequired: !isOptional,
      isList: isList === "[]",
      isId: modStr.includes("@id"),
      isUnique: modStr.includes("@unique"),
      hasDefault: modStr.includes("@default"),
      isRelation: modStr.includes("@relation"),
    });
  }

  return fields;
}

/**
 * Parses @@index or @@unique directives from a model body.
 *
 * Example: `@@index([email, name])` -> [["email", "name"]]
 */
function parseDirective(body: string, directive: string): string[][] {
  const results: string[][] = [];
  // Escape the @ signs for regex
  const _escaped = directive.replace(/@/g, "@@").replace(/@@@@/g, "@@");
  const regex = new RegExp(
    `${directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(\\s*\\[([^\\]]+)\\]`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const fields = match[1]
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    results.push(fields);
  }

  return results;
}

/**
 * Parses all enum blocks from the schema content.
 */
function parseEnums(content: string): PrismaEnum[] {
  const enums: PrismaEnum[] = [];
  const enumRegex = /enum\s+(\w+)\s*\{([^}]*)\}/gs;

  let match: RegExpExecArray | null;
  while ((match = enumRegex.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];
    const values = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .map((line) => line.split(/\s/)[0]) // strip inline comments
      .filter(Boolean);

    enums.push({ name, values });
  }

  return enums;
}

// ---------------------------------------------------------------------------
// Cross-referencing
// ---------------------------------------------------------------------------

/**
 * Cross-references Prisma database calls against the parsed schema.
 *
 * Checks for:
 * - Calls to nonexistent models
 * - Calls referencing nonexistent fields in where/select/include clauses
 * - Frequently queried fields that lack an @@index
 *
 * @param schema   Parsed Prisma schema information.
 * @param dbCalls  Database calls extracted from source code.
 * @returns        Array of PrismaIssue objects.
 */
export function crossReferenceCalls(
  schema: PrismaSchemaInfo,
  dbCalls: DatabaseCall[],
): PrismaIssue[] {
  const issues: PrismaIssue[] = [];

  // Build a lookup map: lowercase model name -> PrismaModel
  const modelMap = new Map<string, PrismaModel>();
  for (const model of schema.models) {
    modelMap.set(model.name.toLowerCase(), model);
  }

  // Track field query frequency for index suggestions
  const fieldQueryCount = new Map<string, number>();

  for (const call of dbCalls) {
    const modelName = call.model.toLowerCase();
    const model = modelMap.get(modelName);

    // Check if model exists
    if (!model) {
      issues.push({
        type: "nonexistent-model",
        description: `Database call references model "${call.model}" which does not exist in the Prisma schema.`,
        model: call.model,
        field: null,
        file: call.file,
        line: call.line,
      });
      continue;
    }

    // Build a set of field names on the model
    const fieldNames = new Set(model.fields.map((f) => f.name));

    // Check if referenced fields exist
    for (const field of call.fields) {
      if (!fieldNames.has(field)) {
        issues.push({
          type: "nonexistent-field",
          description: `Database call references field "${field}" on model "${model.name}" but this field does not exist in the schema.`,
          model: model.name,
          field,
          file: call.file,
          line: call.line,
        });
      } else {
        // Track query frequency for index suggestions
        const key = `${model.name}.${field}`;
        fieldQueryCount.set(key, (fieldQueryCount.get(key) ?? 0) + 1);
      }
    }
  }

  // Check for frequently queried fields that lack indexes
  const INDEX_THRESHOLD = 2;
  for (const [key, count] of fieldQueryCount) {
    if (count < INDEX_THRESHOLD) continue;

    const [modelName, fieldName] = key.split(".");
    const model = modelMap.get(modelName.toLowerCase());
    if (!model) continue;

    // Check if field is already indexed (@@index, @@unique, @id, @unique)
    const field = model.fields.find((f) => f.name === fieldName);
    if (field && (field.isId || field.isUnique)) continue;

    const isIndexed = model.indexes.some((idx) => idx.includes(fieldName));
    const isUnique = model.uniqueConstraints.some((uc) => uc.includes(fieldName));

    if (!isIndexed && !isUnique) {
      issues.push({
        type: "missing-index",
        description: `Field "${fieldName}" on model "${modelName}" is queried ${count} times but has no @@index. Consider adding an index for better query performance.`,
        model: modelName,
        field: fieldName,
        file: "",
        line: 0,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Migration drift detection
// ---------------------------------------------------------------------------

/**
 * Detects potential migration drift by comparing schema modification time
 * against the latest migration timestamp.
 *
 * This is a heuristic check, not a full drift detection. It flags:
 * - Missing migrations directory
 * - Schema modified more recently than last migration (potential drift)
 * - Stale migrations (>30 days old with recent schema changes)
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Array of MigrationIssue objects.
 */
export async function detectMigrationDrift(projectPath: string): Promise<MigrationIssue[]> {
  const issues: MigrationIssue[] = [];
  const migrationsDir = join(projectPath, "prisma", "migrations");

  // Check if migrations directory exists
  if (!existsSync(migrationsDir)) {
    const schemaPath = findSchemaFile(projectPath);
    if (schemaPath) {
      issues.push({
        type: "no-migrations",
        description:
          "Prisma schema exists but no migrations directory found. Run `prisma migrate dev` to create your initial migration.",
      });
    }
    return issues;
  }

  // Find migration directories (named like 20240101120000_init)
  let migrationDirs: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    migrationDirs = entries
      .filter((e) => e.isDirectory() && /^\d{14}/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    /* skip: unable to read migrations directory */
    return issues;
  }

  if (migrationDirs.length === 0) {
    return issues;
  }

  // Get the last migration timestamp
  const lastMigrationName = migrationDirs[migrationDirs.length - 1];
  const timestampStr = lastMigrationName.slice(0, 14);
  const lastMigrationDate = parseMigrationTimestamp(timestampStr);

  if (!lastMigrationDate) {
    return issues;
  }

  // Get schema modification time
  const schemaPath = findSchemaFile(projectPath);
  if (!schemaPath) {
    return issues;
  }

  try {
    const schemaStat = await stat(schemaPath);
    const schemaModified = schemaStat.mtime;
    const now = new Date();
    const daysSinceLastMigration = Math.floor(
      (now.getTime() - lastMigrationDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Check if schema was modified after the last migration
    if (schemaModified > lastMigrationDate) {
      issues.push({
        type: "drift-suspected",
        description: `Schema file was modified after the last migration (${lastMigrationName}). The schema may be out of sync with the database. Run \`prisma migrate dev\` to generate a new migration.`,
      });
    }

    // Check if migrations are stale (>30 days old)
    if (daysSinceLastMigration > 30 && schemaModified > lastMigrationDate) {
      issues.push({
        type: "stale-migration",
        description: `Last migration (${lastMigrationName}) is ${daysSinceLastMigration} days old and schema has been modified since. This may indicate forgotten migrations.`,
      });
    }
  } catch {
    /* skip: unable to stat schema file */
  }

  return issues;
}

/**
 * Parses a Prisma migration timestamp string (YYYYMMDDHHMMSS) into a Date.
 */
function parseMigrationTimestamp(ts: string): Date | null {
  if (ts.length < 14) return null;

  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10) - 1; // 0-indexed
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(8, 10), 10);
  const minute = parseInt(ts.slice(10, 12), 10);
  const second = parseInt(ts.slice(12, 14), 10);

  const date = new Date(year, month, day, hour, minute, second);
  if (Number.isNaN(date.getTime())) return null;

  return date;
}
