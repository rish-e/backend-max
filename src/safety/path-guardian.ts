/**
 * Path Guardian — Validates and sandboxes all file system access.
 * Prevents scanning sensitive directories, path traversal attacks,
 * and access to files outside the project boundary.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories that must never be scanned (relative to home). */
export const BLOCKED_PATHS: string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  "Library/Keychains",
  ".password-store",
  ".docker/config.json",
  ".kube",
  ".npmrc",
];

/** File patterns that must never be read or returned. */
export const BLOCKED_FILE_PATTERNS: string[] = [
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  ".env",
  ".env.local",
  "id_rsa*",
  "id_ed25519*",
  "*.keystore",
];

/** System directories that must never be scanned. */
const SYSTEM_DIRS: string[] = [
  "/etc",
  "/usr",
  "/var",
  "/sys",
  "/proc",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
];

/** Directories within a project that are off-limits for reads. */
const BLOCKED_PROJECT_DIRS: string[] = [
  ".git/objects",
  ".git/refs",
  "node_modules/.cache",
  ".next/cache",
];

/** Directories that are never writable. */
const NO_WRITE_DIRS: string[] = ["node_modules/", ".git/", "dist/", "build/", ".next/"];

/** File extensions allowed for writes. */
const WRITABLE_EXTENSIONS: Set<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Config files in project root that must not be written. */
const ROOT_CONFIG_FILES: Set<string> = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
  "eslint.config.js",
  ".eslintrc.json",
  ".eslintrc.js",
  ".prettierrc",
  ".prettierrc.json",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vite.config.ts",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a path, expanding ~ and resolving symlinks where possible.
 */
function resolveFull(p: string): string {
  let expanded = p;
  if (expanded.startsWith("~")) {
    expanded = expanded.replace(/^~/, homedir());
  }
  expanded = resolve(expanded);
  try {
    expanded = realpathSync(expanded);
  } catch {
    // Path may not exist yet; return the resolved version
  }
  return expanded;
}

/**
 * Check if a file name matches a blocked pattern.
 * Supports simple glob: *.ext and prefix* patterns, plus exact matches.
 */
function matchesBlockedPattern(fileName: string, pattern: string): boolean {
  if (pattern.startsWith("*")) {
    // e.g. *.pem
    return fileName.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    // e.g. id_rsa*
    return fileName.startsWith(pattern.slice(0, -1));
  }
  // Exact match
  return fileName === pattern;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate that a project path is safe to scan.
 *
 * @param projectPath - The path to validate.
 * @returns An object with `valid` boolean and optional `reason` for rejection.
 */
export function validateProjectPath(projectPath: string): { valid: boolean; reason?: string } {
  try {
    const resolved = resolveFull(projectPath);

    // Must exist
    if (!existsSync(resolved)) {
      return { valid: false, reason: `Path does not exist: ${resolved}` };
    }

    // Must be a directory
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { valid: false, reason: `Path is not a directory: ${resolved}` };
    }

    // Must not be the home directory itself
    const home = resolveFull("~");
    if (resolved === home) {
      return {
        valid: false,
        reason: "Cannot scan the home directory itself. Provide a project subdirectory.",
      };
    }

    // Must not be a system directory
    for (const sysDir of SYSTEM_DIRS) {
      if (resolved === sysDir || resolved.startsWith(`${sysDir}/`)) {
        return {
          valid: false,
          reason: `Cannot scan system directory: ${sysDir}`,
        };
      }
    }

    // Must not match any blocked path (relative to home)
    const relToHome = relative(home, resolved);
    for (const blocked of BLOCKED_PATHS) {
      if (
        relToHome === blocked ||
        relToHome.startsWith(`${blocked}/`) ||
        resolved.endsWith(`/${blocked}`)
      ) {
        // Special case for .npmrc: only block if it contains authToken
        if (blocked === ".npmrc") {
          try {
            const content = readFileSync(resolved, "utf-8");
            if (!content.includes("authToken")) continue;
          } catch {
            continue;
          }
        }
        return {
          valid: false,
          reason: `Path matches blocked sensitive directory: ${blocked}`,
        };
      }
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `Path validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check whether a file is allowed to be read within a project.
 *
 * @param filePath    - Absolute path to the file.
 * @param projectPath - Absolute path to the project root.
 * @returns `true` if the file may be read.
 */
export function isAllowedFile(filePath: string, projectPath: string): boolean {
  try {
    const resolvedFile = resolveFull(filePath);
    const resolvedProject = resolveFull(projectPath);

    // File must be within the project directory
    const rel = relative(resolvedProject, resolvedFile);
    if (rel.startsWith("..") || resolve(resolvedProject, rel) !== resolvedFile) {
      return false;
    }

    // Check blocked file patterns
    const fileName = basename(resolvedFile);
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (matchesBlockedPattern(fileName, pattern)) {
        return false;
      }
    }

    // Check blocked directories within the project
    for (const blockedDir of BLOCKED_PROJECT_DIRS) {
      if (rel.startsWith(blockedDir) || rel.includes(`/${blockedDir}`)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a file is safe to write within a project.
 * Applies all read restrictions plus additional write-specific guards.
 *
 * @param filePath    - Absolute path to the file.
 * @param projectPath - Absolute path to the project root.
 * @returns `true` if the file may be written.
 */
export function isWriteSafe(filePath: string, projectPath: string): boolean {
  // Must pass read checks first
  if (!isAllowedFile(filePath, projectPath)) {
    return false;
  }

  try {
    const resolvedFile = resolveFull(filePath);
    const resolvedProject = resolveFull(projectPath);
    const rel = relative(resolvedProject, resolvedFile);
    const fileName = basename(resolvedFile);
    const ext = extname(resolvedFile);

    // Must be a source file
    if (!WRITABLE_EXTENSIONS.has(ext)) {
      return false;
    }

    // Must not be a root config file
    if (ROOT_CONFIG_FILES.has(fileName)) {
      // Only block if the file is directly in the project root
      if (relative(resolvedProject, resolvedFile) === fileName) {
        return false;
      }
    }

    // Must not be in a no-write directory
    for (const dir of NO_WRITE_DIRS) {
      if (rel.startsWith(dir) || rel.includes(`/${dir}`)) {
        return false;
      }
    }

    // Must not be a generated file
    if (existsSync(resolvedFile)) {
      try {
        const content = readFileSync(resolvedFile, "utf-8");
        const head = content.slice(0, 200);
        if (head.includes("// @generated") || head.includes("/* eslint-disable */")) {
          return false;
        }
      } catch {
        // If we can't read it, treat as unsafe
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize .env file content by stripping values, preserving only variable names.
 * Comments are preserved as-is.
 *
 * @param content - Raw .env file content.
 * @returns Content with values stripped: "DATABASE_URL=postgres://..." becomes "DATABASE_URL=".
 */
export function sanitizeEnvContent(content: string): string {
  const lines = content.split("\n");
  const sanitized: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Preserve empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      sanitized.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      sanitized.push(line);
      continue;
    }

    const varName = trimmed.slice(0, eqIdx).trim();
    sanitized.push(`${varName}=`);
  }

  return sanitized.join("\n");
}
