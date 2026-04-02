// =============================================================================
// backend-max — Main diagnosis orchestrator
// =============================================================================

import { join } from "node:path";
import { runSafetyChecks, sanitizeForDisk } from "../safety/index.js";
import type {
  ContractResult,
  DiagnosisReport,
  Issue,
  ProjectContext,
  ScanResult,
} from "../types.js";
import {
  calculateHealthScore,
  ensureDir,
  generateIssueId,
  getTimestamp,
  writeJson,
} from "../utils/helpers.js";
import { auditApiVersioning } from "./api-versioning-auditor.js";
import { getContext, initContext } from "./context-manager.js";
import { checkContracts } from "./contract-checker.js";
import { scanDependencies } from "./dep-scanner.js";
import { generateDocs } from "./doc-generator.js";
import { scanEnvVars } from "./env-scanner.js";
import { auditErrorHandling } from "./error-auditor.js";
import { updateLedger } from "./ledger-manager.js";
import { visualizeMiddleware } from "./middleware-visualizer.js";
import { getProjectInsights, trackPatterns } from "./pattern-tracker.js";
import { auditPerformance } from "./performance-auditor.js";
import { auditPrisma } from "./prisma-auditor.js";
import { auditRateLimitAndCaching } from "./rate-limit-auditor.js";
import { scanRoutes } from "./route-scanner.js";
import { auditSecurity } from "./security-auditor.js";
import { auditServerActions } from "./server-actions-auditor.js";
import { auditSecrets } from "./secrets-auditor.js";
import { auditMigrations } from "./migration-auditor.js";
import { auditGraphQL } from "./graphql-auditor.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** Subdirectory for saved reports. */
const REPORTS_DIR = "reports";

// ---------------------------------------------------------------------------
// Focus area configuration
// ---------------------------------------------------------------------------

type FocusArea =
  | "all"
  | "routes"
  | "contracts"
  | "errors"
  | "env"
  | "security"
  | "performance"
  | "prisma"
  | "server-actions"
  | "dependencies"
  | "rate-limiting"
  | "versioning"
  | "middleware"
  | "secrets"
  | "migrations"
  | "graphql";

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

  // 0. Run safety checks — fail fast if path is invalid
  const safetyResult = await runSafetyChecks(projectPath);
  if (!safetyResult.passed) {
    return {
      timestamp,
      healthScore: 0,
      issues: [],
      summary: `Safety check failed: ${safetyResult.pathValidation.reason ?? "Unknown reason"}`,
      routeCount: 0,
      endpointCount: 0,
      contractResult: null,
      context: {
        name: "unknown",
        type: "unknown",
        framework: "unknown",
        database: null,
        auth: null,
        domains: [],
        notes: [
          `Safety check blocked this scan: ${safetyResult.pathValidation.reason ?? "Unknown"}`,
        ],
      },
    };
  }

  // 1. Ensure context exists
  let context: ProjectContext;
  try {
    context = await getContext(projectPath);
  } catch {
    /* No existing context — initialize fresh */
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
    } catch (e) {
      console.error("[orchestrator] Contract check skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Error handling audit
  if (shouldRun(focusArea, "errors")) {
    try {
      const errorIssues = await auditErrorHandling(projectPath);
      if (Array.isArray(errorIssues)) {
        allIssues.push(...errorIssues);
      }
    } catch (e) {
      console.error("[orchestrator] Error audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Environment variable audit
  if (shouldRun(focusArea, "env")) {
    try {
      const envIssues = await scanEnvVars(projectPath);
      if (Array.isArray(envIssues)) {
        allIssues.push(...envIssues);
      }
    } catch (e) {
      console.error("[orchestrator] Env audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Security audit
  if (shouldRun(focusArea, "security")) {
    try {
      const secIssues = await auditSecurity(projectPath);
      if (Array.isArray(secIssues)) {
        allIssues.push(...secIssues);
      }
    } catch (e) {
      console.error("[orchestrator] Security audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Performance audit
  if (shouldRun(focusArea, "performance")) {
    try {
      const perfResult = await auditPerformance(projectPath);
      if (perfResult && Array.isArray(perfResult.issues)) {
        allIssues.push(...perfResult.issues);
      }
    } catch (e) {
      console.error(
        "[orchestrator] Performance audit skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Prisma audit
  if (shouldRun(focusArea, "prisma")) {
    try {
      const prismaResult = await auditPrisma(projectPath);
      if (prismaResult && Array.isArray(prismaResult.issues)) {
        allIssues.push(...prismaResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Prisma audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Server actions audit
  if (shouldRun(focusArea, "server-actions")) {
    try {
      const saResult = await auditServerActions(projectPath);
      if (saResult && Array.isArray(saResult.issues)) {
        allIssues.push(...saResult.issues);
      }
    } catch (e) {
      console.error(
        "[orchestrator] Server actions audit skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Dependency vulnerability scan
  if (shouldRun(focusArea, "dependencies")) {
    try {
      const depResult = await scanDependencies(projectPath);
      if (depResult && Array.isArray(depResult.issues)) {
        allIssues.push(...depResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Dependency scan skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Rate limiting & caching audit
  if (shouldRun(focusArea, "rate-limiting") || shouldRun(focusArea, "security")) {
    try {
      const rlResult = await auditRateLimitAndCaching(projectPath);
      if (rlResult && Array.isArray(rlResult.issues)) {
        allIssues.push(...rlResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Rate-limit audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // API versioning audit
  if (shouldRun(focusArea, "versioning")) {
    try {
      const verResult = await auditApiVersioning(projectPath);
      if (verResult && Array.isArray(verResult.issues)) {
        allIssues.push(...verResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Versioning audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Secrets scan (always run with security or "all")
  if (shouldRun(focusArea, "secrets") || shouldRun(focusArea, "security")) {
    try {
      const secretsResult = await auditSecrets(projectPath);
      if (secretsResult && Array.isArray(secretsResult.issues)) {
        allIssues.push(...secretsResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Secrets audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Migration audit (always run with prisma or "all")
  if (shouldRun(focusArea, "migrations") || shouldRun(focusArea, "prisma")) {
    try {
      const migResult = await auditMigrations(projectPath);
      if (migResult && Array.isArray(migResult.issues)) {
        allIssues.push(...migResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Migration audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // GraphQL security audit
  if (shouldRun(focusArea, "graphql") || shouldRun(focusArea, "security")) {
    try {
      const gqlResult = await auditGraphQL(projectPath);
      if (gqlResult && Array.isArray(gqlResult.issues)) {
        allIssues.push(...gqlResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] GraphQL audit skipped:", e instanceof Error ? e.message : e);
    }
  }

  // Middleware chain visualization
  if (shouldRun(focusArea, "middleware") || shouldRun(focusArea, "security")) {
    try {
      const mwResult = await visualizeMiddleware(projectPath);
      if (mwResult && Array.isArray(mwResult.issues)) {
        allIssues.push(...mwResult.issues);
      }
    } catch (e) {
      console.error("[orchestrator] Middleware audit skipped:", e instanceof Error ? e.message : e);
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
  } catch (e) {
    console.error("[orchestrator] Ledger update failed:", e instanceof Error ? e.message : e);
  }

  // 6. Generate documentation
  try {
    await generateDocs(projectPath);
  } catch (e) {
    console.error("[orchestrator] Doc generation failed:", e instanceof Error ? e.message : e);
  }

  // 7. Build summary
  const criticalCount = allIssues.filter(
    (i) => i.severity === "critical" || i.severity === "bug",
  ).length;
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

  // 7b. Track patterns and gather insights (opt-in, non-fatal)
  try {
    await trackPatterns(allIssues, context);
    const insights = await getProjectInsights(allIssues);
    if (insights.length > 0) {
      summaryParts.push(`Pattern insights: ${insights.join(" ")}`);
    }
  } catch (e) {
    console.error("[orchestrator] Pattern tracking failed:", e instanceof Error ? e.message : e);
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

  // 8. Save the report (sanitized for disk)
  try {
    const reportsDir = join(projectPath, STATE_DIR, REPORTS_DIR);
    await ensureDir(reportsDir);
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const sanitizedReport = sanitizeForDisk(report);
    await writeJson(join(reportsDir, `${safeTimestamp}.json`), sanitizedReport);
  } catch (e) {
    console.error("[orchestrator] Report save failed:", e instanceof Error ? e.message : e);
  }

  return report;
}
