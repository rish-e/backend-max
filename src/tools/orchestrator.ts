// =============================================================================
// backend-max — Main diagnosis orchestrator
// =============================================================================

import { join } from "node:path";
import type {
  DiagnosisReport,
  Issue,
  ScanResult,
  ContractResult,
  ProjectContext,
} from "../types.js";
import { scanRoutes } from "./route-scanner.js";
import { checkContracts } from "./contract-checker.js";
import { auditErrorHandling } from "./error-auditor.js";
import { scanEnvVars } from "./env-scanner.js";
import { auditSecurity } from "./security-auditor.js";
import { auditPerformance } from "./performance-auditor.js";
import { generateDocs } from "./doc-generator.js";
import { updateLedger } from "./ledger-manager.js";
import { initContext, getContext } from "./context-manager.js";
import {
  ensureDir,
  writeJson,
  generateIssueId,
  calculateHealthScore,
  getTimestamp,
} from "../utils/helpers.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** Subdirectory for saved reports. */
const REPORTS_DIR = "reports";

// ---------------------------------------------------------------------------
// Focus area configuration
// ---------------------------------------------------------------------------

type FocusArea = "all" | "routes" | "contracts" | "errors" | "env" | "security" | "performance";

/**
 * Determines which audits to run based on the focus parameter.
 */
function shouldRun(focus: FocusArea, area: FocusArea): boolean {
  return focus === "all" || focus === area;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs a full (or focused) backend diagnosis.
 *
 * Steps:
 * 1. Ensure project context exists.
 * 2. Run audits based on focus.
 * 3. Assign deterministic IDs to all issues.
 * 4. Calculate health score.
 * 5. Update the issue ledger.
 * 6. Generate documentation.
 * 7. Save the report.
 * 8. Return the DiagnosisReport.
 *
 * @param projectPath - Absolute path to the project root.
 * @param focus       - Which area to focus on ("all" runs everything).
 * @returns The full diagnosis report.
 */
export async function runFullDiagnosis(
  projectPath: string,
  focus: string,
): Promise<DiagnosisReport> {
  const focusArea = (focus || "all") as FocusArea;
  const timestamp = getTimestamp();

  // 1. Ensure context exists
  let context: ProjectContext;
  try {
    context = await getContext(projectPath);
  } catch {
    context = await initContext(projectPath);
  }

  // 2. Run audits based on focus
  const allIssues: Issue[] = [];
  let scanResult: ScanResult | null = null;
  let contractResult: ContractResult | null = null;

  // Routes are needed by most audits, so scan them if any relevant focus is set
  if (
    shouldRun(focusArea, "routes") ||
    shouldRun(focusArea, "contracts") ||
    shouldRun(focusArea, "errors") ||
    shouldRun(focusArea, "security") ||
    shouldRun(focusArea, "performance")
  ) {
    try {
      scanResult = await scanRoutes(projectPath);
    } catch (err) {
      allIssues.push({
        id: "",
        category: "nextjs",
        severity: "warning",
        title: "Route scan failed",
        description: `Could not scan routes: ${err instanceof Error ? err.message : String(err)}`,
        file: projectPath,
        line: null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }
  }

  // Contracts
  if (shouldRun(focusArea, "contracts")) {
    try {
      contractResult = await checkContracts(projectPath);
      for (const mismatch of contractResult.mismatches) {
        allIssues.push({
          id: "",
          category: "contract",
          severity: mismatch.severity,
          title: `Contract mismatch: ${mismatch.frontendCall.method} ${mismatch.frontendCall.url}`,
          description: mismatch.reason,
          file: mismatch.frontendCall.file,
          line: mismatch.frontendCall.line,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    } catch {
      // Contract check may fail if no frontend code exists — non-fatal
    }
  }

  // Error handling audit
  if (shouldRun(focusArea, "errors")) {
    try {
      const errorIssues = await auditErrorHandling(projectPath);
      if (Array.isArray(errorIssues)) {
        allIssues.push(...errorIssues);
      }
    } catch {
      // Non-fatal
    }
  }

  // Environment variable audit
  if (shouldRun(focusArea, "env")) {
    try {
      const envIssues = await scanEnvVars(projectPath);
      if (Array.isArray(envIssues)) {
        allIssues.push(...envIssues);
      }
    } catch {
      // Non-fatal
    }
  }

  // Security audit
  if (shouldRun(focusArea, "security")) {
    try {
      const secIssues = await auditSecurity(projectPath);
      if (Array.isArray(secIssues)) {
        allIssues.push(...secIssues);
      }
    } catch {
      // Non-fatal
    }
  }

  // Performance audit
  if (shouldRun(focusArea, "performance")) {
    try {
      const perfIssues = await auditPerformance(projectPath);
      if (Array.isArray(perfIssues)) {
        allIssues.push(...perfIssues);
      }
    } catch {
      // Non-fatal
    }
  }

  // 3. Assign deterministic IDs to issues that don't have one
  for (const issue of allIssues) {
    if (!issue.id) {
      issue.id = generateIssueId(issue.category, issue.file, issue.title);
    }
  }

  // 4. Calculate health score
  const healthScore = calculateHealthScore(allIssues);

  // 5. Update the ledger
  try {
    await updateLedger(projectPath, allIssues);
  } catch {
    // Ledger update failure should not break the diagnosis
  }

  // 6. Generate documentation
  try {
    await generateDocs(projectPath);
  } catch {
    // Doc generation failure should not break the diagnosis
  }

  // 7. Build summary
  const criticalCount = allIssues.filter((i) => i.severity === "critical" || i.severity === "bug").length;
  const warningCount = allIssues.filter((i) => i.severity === "warning").length;
  const infoCount = allIssues.filter((i) => i.severity === "info").length;
  const routeCount = scanResult?.summary.totalRoutes ?? 0;
  const endpointCount = scanResult?.summary.totalEndpoints ?? 0;

  const summaryParts: string[] = [
    `Health score: ${healthScore}/100.`,
    `Found ${allIssues.length} issue(s): ${criticalCount} critical, ${warningCount} warnings, ${infoCount} info.`,
    `Scanned ${routeCount} route file(s) with ${endpointCount} endpoint(s).`,
  ];

  if (contractResult) {
    summaryParts.push(
      `Contract analysis: ${contractResult.matchedCount} matched, ${contractResult.unmatchedCount} unmatched.`,
    );
  }

  const report: DiagnosisReport = {
    timestamp,
    healthScore,
    issues: allIssues,
    summary: summaryParts.join(" "),
    routeCount,
    endpointCount,
    contractResult,
    context,
  };

  // 8. Save the report
  try {
    const reportsDir = join(projectPath, STATE_DIR, REPORTS_DIR);
    await ensureDir(reportsDir);
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    await writeJson(join(reportsDir, `${safeTimestamp}.json`), report);
  } catch {
    // Non-fatal — report is still returned
  }

  return report;
}
