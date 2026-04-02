/**
 * Scope Limiter — Prevents resource exhaustion by enforcing limits
 * on file count, file size, scan depth, and memory usage.
 */

import { existsSync, statSync } from "node:fs";
import { appendFile, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { ScopeLimits } from "../types.js";
import { readJsonSafe } from "../utils/helpers.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS: ScopeLimits = {
  maxFiles: 5000,
  maxFileSizeBytes: 1_048_576, // 1 MB
  maxScanDepth: 15,
  maxTotalSizeBytes: 104_857_600, // 100 MB
  reportRetentionDays: 30,
  autoGitignore: true,
  ignoreDirs: ["node_modules", ".next", "dist", "build", ".git", "coverage", ".turbo"],
};

/** State directory used by backend-max. */
const STATE_DIR = ".backend-doctor";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load scope limits from the project's `.backend-doctor/config.json`,
 * merged with built-in defaults.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns Resolved scope limits.
 */
export async function loadLimits(projectPath: string): Promise<ScopeLimits> {
  const configPath = join(projectPath, STATE_DIR, "config.json");
  const userConfig = await readJsonSafe<Partial<ScopeLimits>>(configPath, {});

  return {
    ...DEFAULT_LIMITS,
    ...userConfig,
    ignoreDirs: userConfig.ignoreDirs ?? DEFAULT_LIMITS.ignoreDirs,
  };
}

/**
 * Filter a list of files according to scope limits.
 * Returns the allowed files, skipped files, and any warnings generated.
 *
 * @param projectPath - Absolute path to the project root.
 * @param files       - Array of absolute file paths to evaluate.
 * @returns Object with `allowed`, `skipped`, and `warnings` arrays.
 */
export async function enforceLimits(
  projectPath: string,
  files: string[],
): Promise<{ allowed: string[]; skipped: string[]; warnings: string[] }> {
  const limits = await loadLimits(projectPath);
  const allowed: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const filePath of files) {
    const rel = relative(projectPath, filePath);
    const segments = rel.split("/");

    // Filter out files in ignored directories
    const inIgnored = segments.some((seg) => limits.ignoreDirs.includes(seg));
    if (inIgnored) {
      skipped.push(filePath);
      continue;
    }

    // Filter out files deeper than maxScanDepth
    if (segments.length > limits.maxScanDepth) {
      skipped.push(filePath);
      if (skipped.length <= 5) {
        warnings.push(`Skipped (too deep): ${rel}`);
      }
      continue;
    }

    // Filter out files exceeding maxFileSizeBytes
    try {
      const fileStat = statSync(filePath);
      if (fileStat.size > limits.maxFileSizeBytes) {
        skipped.push(filePath);
        if (skipped.length <= 5) {
          warnings.push(`Skipped (too large: ${(fileStat.size / 1024).toFixed(0)}KB): ${rel}`);
        }
        continue;
      }
    } catch {
      skipped.push(filePath);
      continue;
    }

    allowed.push(filePath);
  }

  // If remaining files exceed maxFiles, prioritize
  if (allowed.length > limits.maxFiles) {
    warnings.push(
      `File count (${allowed.length}) exceeds limit (${limits.maxFiles}). Prioritizing route and source files.`,
    );

    // Sort: route files first, then .ts files, then others
    allowed.sort((a, b) => {
      const aRel = relative(projectPath, a);
      const bRel = relative(projectPath, b);
      const aIsRoute = aRel.includes("route.") || aRel.includes("/api/");
      const bIsRoute = bRel.includes("route.") || bRel.includes("/api/");
      const aIsTs = extname(a) === ".ts" || extname(a) === ".tsx";
      const bIsTs = extname(b) === ".ts" || extname(b) === ".tsx";

      if (aIsRoute && !bIsRoute) return -1;
      if (!aIsRoute && bIsRoute) return 1;
      if (aIsTs && !bIsTs) return -1;
      if (!aIsTs && bIsTs) return 1;
      return 0;
    });

    const excess = allowed.splice(limits.maxFiles);
    skipped.push(...excess);
  }

  if (skipped.length > 5) {
    warnings.push(`... and ${skipped.length - 5} more files skipped.`);
  }

  return { allowed, skipped, warnings };
}

/**
 * Delete reports older than the configured retention period.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns Object with the count of pruned reports.
 */
export async function pruneOldReports(projectPath: string): Promise<{ pruned: number }> {
  const limits = await loadLimits(projectPath);
  const reportsDir = join(projectPath, STATE_DIR, "reports");

  let pruned = 0;

  try {
    const entries = await readdir(reportsDir);
    const cutoff = Date.now() - limits.reportRetentionDays * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      const filePath = join(reportsDir, entry);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtime.getTime() < cutoff) {
          await unlink(filePath);
          pruned++;
        }
      } catch {
        // Skip files we can't stat or delete
      }
    }
  } catch {
    // Reports directory may not exist yet — that's fine
  }

  return { pruned };
}

/**
 * Ensure the project's `.gitignore` includes `.backend-doctor/`.
 * Creates the file if it doesn't exist; appends the entry if missing.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns `true` if the gitignore was modified or created, `false` if no change was needed.
 */
export async function ensureGitignore(projectPath: string): Promise<boolean> {
  const gitignorePath = join(projectPath, ".gitignore");

  try {
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, "utf-8");
      // Check if already listed (handle with/without trailing slash)
      if (content.includes(".backend-doctor/") || content.includes(".backend-doctor\n")) {
        return false;
      }
      await appendFile(
        gitignorePath,
        "\n# Backend Max diagnostic data\n.backend-doctor/\n",
        "utf-8",
      );
      return true;
    } else {
      await writeFile(gitignorePath, "# Backend Max diagnostic data\n.backend-doctor/\n", "utf-8");
      return true;
    }
  } catch {
    // If we can't modify .gitignore, don't fail the whole operation
    return false;
  }
}

/**
 * Compute quick statistics about a set of files.
 *
 * @param files - Array of absolute file paths.
 * @returns Stats including total count, total size, and the largest file.
 */
export function getScanStats(files: string[]): {
  totalFiles: number;
  totalSizeBytes: number;
  largestFile: { path: string; size: number } | null;
} {
  let totalSizeBytes = 0;
  let largestFile: { path: string; size: number } | null = null;

  for (const filePath of files) {
    try {
      const fileStat = statSync(filePath);
      totalSizeBytes += fileStat.size;
      if (!largestFile || fileStat.size > largestFile.size) {
        largestFile = { path: filePath, size: fileStat.size };
      }
    } catch {
      // Skip files we can't stat
    }
  }

  return {
    totalFiles: files.length,
    totalSizeBytes,
    largestFile,
  };
}
