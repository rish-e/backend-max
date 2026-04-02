// =============================================================================
// backend-max — Watch mode / incremental analysis
// =============================================================================

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import type { DiagnosisReport, Issue } from "../types.js";
import { getTimestamp, readJsonSafe } from "../utils/helpers.js";
import { runFullDiagnosis } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an incremental (watch-mode) analysis. */
export interface WatchResult {
  /** Whether this is a full or incremental analysis. */
  mode: "full" | "incremental";
  /** Files that changed since the last diagnosis. */
  changedFiles: string[];
  /** New issues found since the last report. */
  newIssues: Issue[];
  /** Issues that were fixed (present before, absent now). */
  fixedIssues: Issue[];
  /** Total current issues. */
  currentIssues: Issue[];
  /** Current health score. */
  healthScore: number;
  /** Previous health score (null if first run). */
  previousHealthScore: number | null;
  /** Human-readable summary of changes. */
  summary: string;
  /** Full report (available for both modes). */
  report: DiagnosisReport;
}

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** Reports subdirectory. */
const REPORTS_DIR = "reports";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs an incremental analysis — compares current state against the last
 * saved diagnosis report. Only highlights what changed.
 *
 * Note: Currently runs a full diagnosis and diffs against the previous report.
 * True incremental analysis (only scanning changed files) is planned for a future version.
 *
 * If no previous report exists, runs a full diagnosis.
 *
 * @param projectPath  Absolute path to the project root.
 * @param focus        Focus area (same as orchestrator).
 * @returns WatchResult with delta information.
 */
export async function runIncrementalAnalysis(
  projectPath: string,
  focus: string,
): Promise<WatchResult> {
  const _timestamp = getTimestamp();

  // 1. Find the most recent previous report
  const previousReport = await getLatestReport(projectPath);

  // 2. If no previous report, run full diagnosis
  if (!previousReport) {
    const report = await runFullDiagnosis(projectPath, focus);
    return {
      mode: "full",
      changedFiles: [],
      newIssues: report.issues,
      fixedIssues: [],
      currentIssues: report.issues,
      healthScore: report.healthScore,
      previousHealthScore: null,
      summary: `First run — full analysis. ${report.summary}`,
      report,
    };
  }

  // 3. Find files changed since the last report
  const changedFiles = await findChangedFiles(projectPath, previousReport.timestamp);

  // 4. Run full diagnosis (we always run full for accuracy, but report the delta)
  const report = await runFullDiagnosis(projectPath, focus);

  // 5. Compute delta
  const previousIssueIds = new Set(previousReport.issues.map((i) => i.id));
  const currentIssueIds = new Set(report.issues.map((i) => i.id));

  const newIssues = report.issues.filter((i) => !previousIssueIds.has(i.id));
  const fixedIssues = previousReport.issues.filter((i) => !currentIssueIds.has(i.id));

  // 6. Build summary
  const scoreDelta = report.healthScore - previousReport.healthScore;
  const scoreDirection =
    scoreDelta > 0
      ? `+${scoreDelta} (improved)`
      : scoreDelta < 0
        ? `${scoreDelta} (degraded)`
        : "unchanged";

  const summaryParts: string[] = [
    `Health: ${report.healthScore}/100 (${scoreDirection}).`,
    `${changedFiles.length} file(s) changed.`,
  ];

  if (newIssues.length > 0) {
    summaryParts.push(`${newIssues.length} new issue(s).`);
  }
  if (fixedIssues.length > 0) {
    summaryParts.push(`${fixedIssues.length} issue(s) fixed.`);
  }
  if (newIssues.length === 0 && fixedIssues.length === 0) {
    summaryParts.push("No new issues.");
  }

  return {
    mode: "incremental",
    changedFiles,
    newIssues,
    fixedIssues,
    currentIssues: report.issues,
    healthScore: report.healthScore,
    previousHealthScore: previousReport.healthScore,
    summary: summaryParts.join(" "),
    report,
  };
}

/**
 * Returns a quick summary of what changed since the last diagnosis,
 * without re-running the full analysis. Useful for a fast check.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns Summary of changes, or null if no previous report exists.
 */
export async function getChangesSummary(projectPath: string): Promise<{
  changedFiles: string[];
  timeSinceLastRun: string;
  previousScore: number;
} | null> {
  const previousReport = await getLatestReport(projectPath);
  if (!previousReport) return null;

  const changedFiles = await findChangedFiles(projectPath, previousReport.timestamp);

  const lastRunTime = new Date(previousReport.timestamp);
  const now = new Date();
  const diffMs = now.getTime() - lastRunTime.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const timeSinceLastRun =
    diffMins < 60
      ? `${diffMins}m ago`
      : diffMins < 1440
        ? `${Math.floor(diffMins / 60)}h ago`
        : `${Math.floor(diffMins / 1440)}d ago`;

  return {
    changedFiles,
    timeSinceLastRun,
    previousScore: previousReport.healthScore,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Finds the most recent diagnosis report saved to disk.
 */
async function getLatestReport(projectPath: string): Promise<DiagnosisReport | null> {
  const reportsDir = join(projectPath, STATE_DIR, REPORTS_DIR);

  try {
    const reportFiles = await glob("*.json", {
      cwd: reportsDir,
      absolute: true,
      nodir: true,
    });

    if (reportFiles.length === 0) return null;

    // Sort by filename (which is timestamp-based) — latest last
    reportFiles.sort();
    const latestFile = reportFiles[reportFiles.length - 1];

    return readJsonSafe<DiagnosisReport | null>(latestFile, null);
  } catch {
    /* skip: unable to read reports directory */
    return null;
  }
}

/**
 * Finds files modified since a given ISO timestamp.
 */
async function findChangedFiles(projectPath: string, sinceTimestamp: string): Promise<string[]> {
  const sinceTime = new Date(sinceTimestamp).getTime();
  const changed: string[] = [];

  try {
    const sourceFiles = await glob("**/*.{ts,tsx,js,jsx,prisma}", {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/coverage/**",
        "**/.backend-doctor/**",
      ],
    });

    for (const filePath of sourceFiles) {
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs > sinceTime) {
          changed.push(filePath);
        }
      } catch {
        /* skip: unable to stat file */
      }
    }
  } catch {
    /* skip: glob failure */
  }

  return changed;
}
