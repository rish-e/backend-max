/**
 * Safety Module — Unified entry point for all safety systems.
 */

import type { SafetyCheckResult } from "../types.js";

// Re-export everything from sub-modules
export {
  BLOCKED_FILE_PATTERNS,
  BLOCKED_PATHS,
  isAllowedFile,
  isWriteSafe,
  sanitizeEnvContent,
  validateProjectPath,
} from "./path-guardian.js";

export {
  containsSecrets,
  SECRET_PATTERNS,
  sanitizeForDisk,
  sanitizeForOutput,
  sanitizeReport,
} from "./sanitizer.js";

export {
  enforceLimits,
  ensureGitignore,
  getScanStats,
  loadLimits,
  pruneOldReports,
} from "./scope-limiter.js";

// Import for use in the unified check
import { validateProjectPath } from "./path-guardian.js";
import { ensureGitignore, pruneOldReports } from "./scope-limiter.js";

/**
 * Run all safety checks in sequence. This should be called at the start
 * of every tool invocation.
 *
 * 1. Validates the project path (fails fast if invalid).
 * 2. Ensures `.backend-doctor/` is in `.gitignore`.
 * 3. Prunes old reports beyond the retention window.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns The result of all safety checks.
 */
export async function runSafetyChecks(projectPath: string): Promise<SafetyCheckResult> {
  // 1. Validate project path — fail fast
  const pathValidation = validateProjectPath(projectPath);
  if (!pathValidation.valid) {
    return {
      passed: false,
      pathValidation,
      gitignoreAdded: false,
      scopeWarnings: [],
      reportsPruned: 0,
    };
  }

  // 2. Ensure .gitignore includes .backend-doctor/
  let gitignoreAdded = false;
  try {
    gitignoreAdded = await ensureGitignore(projectPath);
  } catch {
    // Non-fatal
  }

  // 3. Prune old reports
  let reportsPruned = 0;
  try {
    const pruneResult = await pruneOldReports(projectPath);
    reportsPruned = pruneResult.pruned;
  } catch {
    // Non-fatal
  }

  return {
    passed: true,
    pathValidation,
    gitignoreAdded,
    scopeWarnings: [],
    reportsPruned,
  };
}
