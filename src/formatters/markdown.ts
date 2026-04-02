// =============================================================================
// backend-max — Markdown report formatter
// =============================================================================

import type { DiagnosisReport, Issue } from "../types.js";

/**
 * Formats a DiagnosisReport as a Markdown string suitable for PR comments
 * or documentation.
 *
 * @param report  The diagnosis report to format.
 * @returns Markdown-formatted string.
 */
export function formatMarkdownReport(report: DiagnosisReport): string {
  const lines: string[] = [];

  // Health score badge
  const badgeColor =
    report.healthScore >= 80 ? "brightgreen" : report.healthScore >= 60 ? "yellow" : "red";
  lines.push(
    `![Health Score](https://img.shields.io/badge/health--score-${report.healthScore}%2F100-${badgeColor})`,
  );
  lines.push("");

  // Header
  lines.push("# Backend Max Diagnosis Report");
  lines.push("");
  lines.push(`**Framework:** ${report.context.framework}`);
  lines.push(`**Routes:** ${report.routeCount} files, ${report.endpointCount} endpoints`);
  lines.push(`**Timestamp:** ${report.timestamp}`);
  lines.push("");

  // Issues by severity
  const critical = report.issues.filter((i) => i.severity === "critical" || i.severity === "bug");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  const info = report.issues.filter((i) => i.severity === "info");

  if (critical.length > 0) {
    lines.push("## Critical Issues");
    lines.push("");
    for (const issue of critical) {
      lines.push(formatIssueMarkdown(issue));
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const issue of warnings) {
      lines.push(formatIssueMarkdown(issue));
    }
    lines.push("");
  }

  if (info.length > 0) {
    lines.push("## Info");
    lines.push("");
    for (const issue of info) {
      lines.push(formatIssueMarkdown(issue));
    }
    lines.push("");
  }

  if (report.issues.length === 0) {
    lines.push("> No issues found -- looking good!");
    lines.push("");
  }

  // Contract analysis
  if (report.contractResult) {
    lines.push("## Contract Analysis");
    lines.push("");
    lines.push(`| Metric | Count |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Matched | ${report.contractResult.matchedCount} |`);
    lines.push(`| Unmatched | ${report.contractResult.unmatchedCount} |`);
    lines.push("");
  }

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Health Score | ${report.healthScore}/100 |`);
  lines.push(`| Critical | ${critical.length} |`);
  lines.push(`| Warnings | ${warnings.length} |`);
  lines.push(`| Info | ${info.length} |`);
  lines.push(`| Total Routes | ${report.routeCount} |`);
  lines.push(`| Total Endpoints | ${report.endpointCount} |`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats a single issue as a collapsible Markdown details block.
 */
function formatIssueMarkdown(issue: Issue): string {
  const location = issue.line ? `\`${issue.file}:${issue.line}\`` : `\`${issue.file}\``;

  return [
    `<details>`,
    `<summary><strong>${issue.title}</strong> (${issue.severity})</summary>`,
    ``,
    `${issue.description}`,
    ``,
    `**Location:** ${location}`,
    `**ID:** \`${issue.id}\``,
    ``,
    `</details>`,
    ``,
  ].join("\n");
}
