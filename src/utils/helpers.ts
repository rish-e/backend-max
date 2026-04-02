// =============================================================================
// backend-max — Shared utility functions
// =============================================================================

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Issue } from "../types.js";

/**
 * Creates a directory (and parents) if it does not already exist.
 *
 * @param dirPath - Absolute path to the directory.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Reads and parses a JSON file, returning a fallback value on any error
 * (missing file, invalid JSON, permission denied, etc.).
 *
 * @param filePath - Absolute path to the JSON file.
 * @param fallback - Value to return when the file cannot be read or parsed.
 * @returns The parsed JSON value or the fallback.
 */
export async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Writes a value as pretty-printed JSON to a file, creating parent
 * directories as needed.
 *
 * @param filePath - Absolute path to the target file.
 * @param data     - Value to serialize.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const dir = resolve(filePath, "..");
  await ensureDir(dir);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Generates a deterministic issue ID based on category, file, and a detail
 * string. The format is `{CATEGORY_PREFIX}-{hash}` where hash is the first
 * 6 hex characters of a SHA-256 digest.
 *
 * @param category - Issue category (e.g. "contract", "security").
 * @param file     - File path where the issue was found.
 * @param detail   - Additional detail string for uniqueness.
 * @returns A stable issue ID like "CTR-a1b2c3".
 */
export function generateIssueId(category: string, file: string, detail: string): string {
  const prefixMap: Record<string, string> = {
    contract: "CTR",
    "contract-type-mismatch": "CTM",
    "error-handling": "ERR",
    validation: "VAL",
    env: "ENV",
    security: "SEC",
    performance: "PRF",
    nextjs: "NXT",
    express: "EXP",
    auth: "AUT",
    prisma: "PRS",
    "server-actions": "SAC",
    trpc: "TPC",
    graphql: "GQL",
    dependency: "DEP",
    fastify: "FST",
    hono: "HNO",
    "rate-limit": "RTL",
    caching: "CCH",
    versioning: "VER",
    middleware: "MDW",
  };

  const prefix = prefixMap[category] ?? category.slice(0, 3).toUpperCase();
  const hash = createHash("sha256").update(`${file}:${detail}`).digest("hex").slice(0, 6);

  return `${prefix}-${hash}`;
}

/**
 * Calculates a health score from 0 to 100 based on issue severities.
 *
 * - Critical / bug: -10 each
 * - Warning: -5 each
 * - Info: -1 each
 *
 * @param issues - Array of issues to score against.
 * @returns Integer health score, floored at 0.
 */
export function calculateHealthScore(issues: Issue[]): number {
  let score = 100;

  for (const issue of issues) {
    switch (issue.severity) {
      case "critical":
      case "bug":
        score -= 10;
        break;
      case "warning":
        score -= 5;
        break;
      case "info":
        score -= 1;
        break;
    }
  }

  return Math.max(0, score);
}

/**
 * Returns the current time as an ISO 8601 timestamp string.
 */
export function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Converts an absolute path to a path relative to the project root.
 *
 * @param projectPath  - Absolute path to the project root.
 * @param absolutePath - Absolute path to convert.
 * @returns Relative path string.
 */
export function relativePath(projectPath: string, absolutePath: string): string {
  return relative(projectPath, absolutePath);
}
