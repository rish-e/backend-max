// =============================================================================
// backend-max — Environment Variable Scanner
//
// Scans the codebase for process.env references, cross-references against
// .env files, and flags missing definitions, unused vars, and missing
// NEXT_PUBLIC_ prefixes.
// =============================================================================

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "glob";
import type { Issue, IssueCategory, Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source file extensions to scan for env var usage. */
const SOURCE_EXTENSIONS = "**/*.{ts,tsx,js,jsx,mjs,cjs}";

/** Directories to skip when scanning source files. */
const IGNORE_DIRS = [
  "node_modules/**",
  ".next/**",
  "dist/**",
  "build/**",
  "out/**",
  ".git/**",
  "coverage/**",
];

/** .env file variants to check, in order of precedence. */
const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.example",
  ".env.test",
];

/** Regex to match process.env.VAR_NAME references. */
const PROCESS_ENV_REGEX = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

/** Regex to match process.env["VAR_NAME"] or process.env['VAR_NAME']. */
const PROCESS_ENV_BRACKET_REGEX =
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;

/** Directories that indicate client-side code. */
const CLIENT_PATHS = [
  "/app/",
  "/pages/",
  "/components/",
  "/hooks/",
  "/contexts/",
  "/providers/",
  "/lib/client",
  "/utils/client",
];

/** Directories that clearly indicate server-side code. */
const SERVER_PATHS = [
  "/api/",
  "/server/",
  "/lib/server",
  "/utils/server",
  "middleware.ts",
  "middleware.js",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvVarInfo {
  name: string;
  usedIn: string[];
  definedIn: string[];
  isPublic: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan environment variable usage across the project.
 *
 * 1. Finds all `process.env.SOMETHING` references in source files.
 * 2. Reads `.env`, `.env.local`, `.env.example`, and other variants.
 * 3. Cross-references to detect:
 *    - Variables used in code but not defined in any .env file.
 *    - Variables in `.env.example` but missing from `.env.local`.
 *    - Client-side code using env vars without `NEXT_PUBLIC_` prefix.
 *    - Variables defined but never referenced in code.
 *
 * @param projectPath Absolute path to the project root.
 * @returns Issues found, per-variable metadata, and a summary.
 */
export async function scanEnvVars(projectPath: string): Promise<{
  issues: Issue[];
  envVars: EnvVarInfo[];
  summary: { total: number; undefined: number; unused: number };
}> {
  const issues: Issue[] = [];

  try {
    // -----------------------------------------------------------------------
    // Step 1: Find all process.env references in source code.
    // -----------------------------------------------------------------------
    const sourceFiles = await glob(SOURCE_EXTENSIONS, {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: IGNORE_DIRS,
    });

    /** Map of env var name -> set of files it appears in. */
    const usageMap = new Map<string, Set<string>>();

    for (const filePath of sourceFiles) {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue; // skip unreadable files
      }

      const relPath = relative(projectPath, filePath);

      // Match process.env.VAR_NAME
      for (const match of content.matchAll(PROCESS_ENV_REGEX)) {
        const varName = match[1];
        if (!usageMap.has(varName)) usageMap.set(varName, new Set());
        usageMap.get(varName)!.add(relPath);
      }

      // Match process.env["VAR_NAME"]
      for (const match of content.matchAll(PROCESS_ENV_BRACKET_REGEX)) {
        const varName = match[1];
        if (!usageMap.has(varName)) usageMap.set(varName, new Set());
        usageMap.get(varName)!.add(relPath);
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Read .env files.
    // -----------------------------------------------------------------------

    /** Map of env var name -> set of .env files it's defined in. */
    const definitionMap = new Map<string, Set<string>>();

    /** Vars defined per specific env file, for cross-referencing. */
    const envFileContents = new Map<string, Set<string>>();

    for (const envFileName of ENV_FILES) {
      const envPath = join(projectPath, envFileName);
      let content: string;
      try {
        content = await readFile(envPath, "utf-8");
      } catch {
        continue; // file doesn't exist
      }

      const varsInFile = new Set<string>();

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        // Skip comments and empty lines.
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) continue;

        const varName = trimmed.slice(0, eqIdx).trim();
        if (!/^[A-Z_][A-Z0-9_]*$/.test(varName)) continue;

        varsInFile.add(varName);

        if (!definitionMap.has(varName)) definitionMap.set(varName, new Set());
        definitionMap.get(varName)!.add(envFileName);
      }

      envFileContents.set(envFileName, varsInFile);
    }

    // -----------------------------------------------------------------------
    // Step 3: Cross-reference and generate issues.
    // -----------------------------------------------------------------------

    // Collect all known var names from both maps.
    const allVarNames = new Set([
      ...usageMap.keys(),
      ...definitionMap.keys(),
    ]);

    const envVars: EnvVarInfo[] = [];

    for (const varName of allVarNames) {
      const usedIn = usageMap.has(varName)
        ? [...usageMap.get(varName)!]
        : [];
      const definedIn = definitionMap.has(varName)
        ? [...definitionMap.get(varName)!]
        : [];
      const isPublic = varName.startsWith("NEXT_PUBLIC_");

      envVars.push({ name: varName, usedIn, definedIn, isPublic });

      // --- Used but not defined in any .env file ---
      if (usedIn.length > 0 && definedIn.length === 0) {
        // Skip well-known Node built-ins.
        if (isBuiltInEnvVar(varName)) continue;

        issues.push(
          makeIssue(
            `ENV-UNDEF-${issues.length + 1}`,
            "env",
            "warning",
            `Undefined env var: ${varName}`,
            `\`process.env.${varName}\` is used in ${usedIn.join(", ")} but is not defined in any .env file. It will be \`undefined\` at runtime unless set externally.`,
            usedIn[0],
            null
          )
        );
      }

      // --- Defined but never used ---
      if (definedIn.length > 0 && usedIn.length === 0) {
        issues.push(
          makeIssue(
            `ENV-UNUSED-${issues.length + 1}`,
            "env",
            "info",
            `Unused env var: ${varName}`,
            `\`${varName}\` is defined in ${definedIn.join(", ")} but is never referenced in the source code. Consider removing it to reduce confusion.`,
            definedIn[0],
            null
          )
        );
      }

      // --- Client-side code without NEXT_PUBLIC_ prefix ---
      if (!isPublic && usedIn.length > 0) {
        const clientFiles = usedIn.filter((f) => isClientSideFile(f));
        if (clientFiles.length > 0) {
          issues.push(
            makeIssue(
              `ENV-CLIENT-${issues.length + 1}`,
              "env",
              "warning",
              `Server env var used in client code: ${varName}`,
              `\`process.env.${varName}\` is used in client-side file(s) ${clientFiles.join(", ")} but does not have the \`NEXT_PUBLIC_\` prefix. It will be \`undefined\` in the browser.`,
              clientFiles[0],
              null
            )
          );
        }
      }
    }

    // --- .env.example vars missing from .env.local ---
    const exampleVars = envFileContents.get(".env.example");
    const localVars = envFileContents.get(".env.local");
    if (exampleVars && localVars) {
      for (const varName of exampleVars) {
        if (!localVars.has(varName)) {
          issues.push(
            makeIssue(
              `ENV-MISSING-LOCAL-${issues.length + 1}`,
              "env",
              "warning",
              `Missing local config: ${varName}`,
              `\`${varName}\` is defined in .env.example but is missing from .env.local. This may cause runtime errors in local development.`,
              ".env.example",
              null
            )
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    const undefinedCount = envVars.filter(
      (v) => v.usedIn.length > 0 && v.definedIn.length === 0
    ).length;
    const unusedCount = envVars.filter(
      (v) => v.definedIn.length > 0 && v.usedIn.length === 0
    ).length;

    return {
      issues,
      envVars,
      summary: {
        total: envVars.length,
        undefined: undefinedCount,
        unused: unusedCount,
      },
    };
  } catch (error) {
    return {
      issues: [
        makeIssue(
          "ENV-INTERNAL-1",
          "env",
          "warning",
          "Env scanner encountered an internal error",
          `The env scanner failed to complete: ${error instanceof Error ? error.message : String(error)}`,
          projectPath,
          null
        ),
      ],
      envVars: [],
      summary: { total: 0, undefined: 0, unused: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if a file path is likely client-side code based on its location.
 * Files in /api/ or /server/ directories are excluded.
 */
function isClientSideFile(relPath: string): boolean {
  // Definitely server-side.
  for (const sp of SERVER_PATHS) {
    if (relPath.includes(sp)) return false;
  }

  // Likely client-side.
  for (const cp of CLIENT_PATHS) {
    if (relPath.includes(cp)) return true;
  }

  // Files with "use client" directive would need content inspection;
  // for now, default to false (server-side) if path is ambiguous.
  return false;
}

/** Well-known Node.js / runtime env vars that don't need .env definitions. */
function isBuiltInEnvVar(name: string): boolean {
  const builtIns = new Set([
    "NODE_ENV",
    "PORT",
    "HOST",
    "HOME",
    "PATH",
    "PWD",
    "SHELL",
    "USER",
    "LANG",
    "TERM",
    "CI",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_URL",
    "VERCEL_GIT_COMMIT_SHA",
    "NEXT_RUNTIME",
  ]);
  return builtIns.has(name);
}

function makeIssue(
  id: string,
  category: IssueCategory,
  severity: Severity,
  title: string,
  description: string,
  file: string,
  line: number | null
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
