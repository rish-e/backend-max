// =============================================================================
// backend-max — Human-readable text formatter (colored terminal output)
// =============================================================================

import chalk, { type ChalkInstance } from "chalk";
import type { DiagnosisReport, Issue } from "../types.js";

/** Box-drawing characters for section headers. */
const BOX = {
  topLeft: "\u250C",
  topRight: "\u2510",
  bottomLeft: "\u2514",
  bottomRight: "\u2518",
  horizontal: "\u2500",
  vertical: "\u2502",
} as const;

/**
 * Formats a DiagnosisReport as a human-readable colored text string
 * suitable for terminal output.
 *
 * @param report  The diagnosis report to format.
 * @returns Formatted string with ANSI color codes.
 */
export function formatTextReport(report: DiagnosisReport): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(sectionHeader("Backend Max Diagnosis Report"));
  lines.push("");

  // Health score
  const scoreColor = getScoreColor(report.healthScore);
  lines.push(`  Health Score: ${scoreColor(`${report.healthScore}/100`)}`);
  lines.push(`  Timestamp:    ${chalk.dim(report.timestamp)}`);
  lines.push(`  Framework:    ${chalk.cyan(report.context.framework)}`);
  lines.push(`  Routes:       ${report.routeCount} files, ${report.endpointCount} endpoints`);
  lines.push("");

  // Issues by severity
  const critical = report.issues.filter((i) => i.severity === "critical" || i.severity === "bug");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  const info = report.issues.filter((i) => i.severity === "info");

  if (critical.length > 0) {
    lines.push(sectionHeader("Critical Issues"));
    for (const issue of critical) {
      lines.push(formatIssue(issue, "\uD83D\uDD34", chalk.red));
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(sectionHeader("Warnings"));
    for (const issue of warnings) {
      lines.push(formatIssue(issue, "\uD83D\uDFE1", chalk.yellow));
    }
    lines.push("");
  }

  if (info.length > 0) {
    lines.push(sectionHeader("Info"));
    for (const issue of info) {
      lines.push(formatIssue(issue, "\uD83D\uDD35", chalk.blue));
    }
    lines.push("");
  }

  if (report.issues.length === 0) {
    lines.push(`  ${"\uD83D\uDFE2"} ${chalk.green("No issues found — looking good!")}`);
    lines.push("");
  }

  // Contract analysis
  if (report.contractResult) {
    lines.push(sectionHeader("Contract Analysis"));
    lines.push(`  Matched:   ${chalk.green(String(report.contractResult.matchedCount))}`);
    lines.push(`  Unmatched: ${chalk.red(String(report.contractResult.unmatchedCount))}`);
    lines.push("");
  }

  // Summary bar
  lines.push(chalk.dim(BOX.horizontal.repeat(60)));
  lines.push(
    `  Backend Max: ${scoreColor(`${String(report.healthScore)}/100`)} | ` +
      `${chalk.red(`${critical.length} critical`)} | ` +
      `${chalk.yellow(`${warnings.length} warnings`)} | ` +
      `${chalk.blue(`${info.length} info`)}`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a chalk color function based on the health score.
 */
function getScoreColor(score: number): ChalkInstance {
  if (score >= 80) return chalk.green;
  if (score >= 60) return chalk.yellow;
  return chalk.red;
}

/**
 * Creates a box-drawing section header.
 */
function sectionHeader(title: string): string {
  const width = 60;
  const inner = width - 2;
  const padded = ` ${title} `.padEnd(inner, BOX.horizontal);
  return chalk.dim(`  ${BOX.topLeft}${BOX.horizontal}${padded}${BOX.topRight}`);
}

/**
 * Formats a single issue line.
 */
function formatIssue(issue: Issue, emoji: string, color: ChalkInstance): string {
  const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  return [
    `  ${emoji} ${color(issue.title)}`,
    `     ${chalk.dim(issue.description)}`,
    `     ${chalk.dim(location)}`,
  ].join("\n");
}
