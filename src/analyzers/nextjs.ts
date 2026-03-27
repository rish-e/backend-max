// =============================================================================
// backend-max — Next.js-specific analysis utilities
// =============================================================================

import { readFile } from "node:fs/promises";
import { join, relative, sep, posix } from "node:path";
import { glob } from "glob";
import type { MiddlewareInfo } from "../types.js";

/**
 * Converts a route.ts / route.js file path to a URL pattern.
 *
 * Handles Next.js conventions:
 * - Strips the `app/` prefix and the `route.ts` / `route.js` filename
 * - Removes route groups like `(marketing)` or `(auth)`
 * - Preserves dynamic segments: `[id]`, `[...slug]`, `[[...optional]]`
 *
 * @param filePath  Absolute or relative path to the route file.
 * @param appDir    Absolute path to the `app/` directory.
 * @returns         URL pattern string, e.g. "/api/users/[id]".
 */
export function filePathToUrl(filePath: string, appDir: string): string {
  // Normalize to forward slashes and get relative path from appDir
  const rel = relative(appDir, filePath).split(sep).join(posix.sep);

  // Remove the trailing /route.ts or /route.js
  const withoutFile = rel.replace(/\/route\.(ts|js)$/, "");

  // Split into segments and process each one
  const segments = withoutFile.split("/").filter(Boolean);
  const processed: string[] = [];

  for (const segment of segments) {
    // Strip route groups: (name) -> skip entirely
    if (/^\(.*\)$/.test(segment)) {
      continue;
    }
    processed.push(segment);
  }

  const url = "/" + processed.join("/");
  return url === "/" ? "/" : url;
}

/**
 * Extracts dynamic parameter names from a URL pattern.
 *
 * Examples:
 * - "/api/users/[id]" -> ["id"]
 * - "/api/[...slug]"  -> ["slug"]
 * - "/api/[[...opt]]" -> ["opt"]
 *
 * @param url  URL pattern string.
 * @returns    Array of parameter names.
 */
export function extractDynamicParams(url: string): string[] {
  const params: string[] = [];

  // Match [[...name]], [...name], and [name]
  const regex = /\[\[?\.\.\.([\w]+)\]?\]|\[([\w]+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(url)) !== null) {
    const paramName = match[1] ?? match[2];
    if (paramName) {
      params.push(paramName);
    }
  }

  return params;
}

/**
 * Checks whether a file path lives under an `api/` directory, indicating it
 * is an API route rather than a page route.
 *
 * @param filePath  Path to the route file.
 * @returns         True if the file is inside an `api/` directory.
 */
export function isApiRoute(filePath: string): boolean {
  const normalized = filePath.split(sep).join(posix.sep);
  return /\/api\//.test(normalized) || /\/api$/.test(normalized);
}

/**
 * Detects and parses the Next.js middleware file (middleware.ts or middleware.js)
 * at the project root.
 *
 * @param projectPath  Root of the Next.js project.
 * @returns            MiddlewareInfo if a middleware file exists, null otherwise.
 */
export async function detectMiddleware(
  projectPath: string,
): Promise<MiddlewareInfo | null> {
  const candidates = ["middleware.ts", "middleware.js"];
  let middlewarePath: string | null = null;
  let content: string | null = null;

  for (const candidate of candidates) {
    const fullPath = join(projectPath, candidate);
    try {
      content = await readFile(fullPath, "utf-8");
      middlewarePath = fullPath;
      break;
    } catch {
      // File doesn't exist — try next candidate
    }
  }

  // Also check inside src/
  if (!middlewarePath) {
    for (const candidate of candidates) {
      const fullPath = join(projectPath, "src", candidate);
      try {
        content = await readFile(fullPath, "utf-8");
        middlewarePath = fullPath;
        break;
      } catch {
        // File doesn't exist
      }
    }
  }

  if (!middlewarePath || !content) {
    return null;
  }

  // Extract matcher patterns from the config export
  const matchers: string[] = [];
  const matcherRegex = /["'`](\/[^"'`]*?)["'`]/g;
  const configSection = content.match(
    /export\s+const\s+config\s*=\s*\{[\s\S]*?\}/,
  );
  if (configSection) {
    let m: RegExpExecArray | null;
    while ((m = matcherRegex.exec(configSection[0])) !== null) {
      matchers.push(m[1]);
    }
  }

  const hasAuth =
    /auth|session|token|getToken|withAuth|clerkMiddleware|authMiddleware/i.test(
      content,
    );
  const hasRedirects = /redirect|NextResponse\.redirect/i.test(content);
  const hasHeaders =
    /headers|NextResponse\.next\(\s*\{[\s\S]*?headers/i.test(content);

  return {
    filePath: middlewarePath,
    matchers,
    hasAuth,
    hasRedirects,
    hasHeaders,
  };
}

/**
 * Extracts route group names from a file path.
 *
 * A route group in Next.js is a directory wrapped in parentheses, e.g. `(auth)`.
 *
 * @param filePath  Path to scan for route group segments.
 * @returns         Array of group names (without parentheses).
 */
export function detectRouteGroups(filePath: string): string[] {
  const normalized = filePath.split(sep).join(posix.sep);
  const groups: string[] = [];
  const regex = /\/\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    groups.push(match[1]);
  }

  return groups;
}

/**
 * Finds the `app/` directory in a Next.js project.
 * Checks both `<root>/app` and `<root>/src/app`.
 *
 * @param projectPath  Root of the Next.js project.
 * @returns            Absolute path to the app directory, or null.
 */
export async function findAppDir(
  projectPath: string,
): Promise<string | null> {
  const candidates = [
    join(projectPath, "app"),
    join(projectPath, "src", "app"),
  ];

  for (const candidate of candidates) {
    const files = await glob("**/route.{ts,js}", {
      cwd: candidate,
      absolute: false,
      nodir: true,
    }).catch(() => []);

    if (files.length > 0) {
      return candidate;
    }
  }

  // Fallback: return whichever exists
  for (const candidate of candidates) {
    const exists = await glob("**/*", {
      cwd: candidate,
      absolute: false,
      nodir: true,
      maxDepth: 1,
    }).catch(() => []);

    if (exists.length > 0) {
      return candidate;
    }
  }

  return null;
}
