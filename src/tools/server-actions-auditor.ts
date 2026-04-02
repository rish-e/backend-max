// =============================================================================
// backend-max — Server Actions Auditor
//
// Audits Next.js Server Actions for common issues: missing validation,
// missing error handling, missing auth, and unprotected database calls.
// =============================================================================

import { scanServerActions } from "../analyzers/server-actions.js";
import type { Issue, IssueCategory, ServerAction, Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audits all Server Actions in a Next.js project.
 *
 * Applies the same quality checks as route handler audits:
 * - Missing validation (no Zod/schema validation) → warning
 * - Missing error handling (no try/catch) → warning
 * - Missing auth (no auth check) → warning
 * - Database calls without error handling → critical
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Issues, action list, and summary statistics.
 */
export async function auditServerActions(projectPath: string): Promise<{
  issues: Issue[];
  actions: ServerAction[];
  summary: {
    total: number;
    withValidation: number;
    withAuth: number;
    withErrorHandling: number;
  };
}> {
  const issues: Issue[] = [];
  let actions: ServerAction[] = [];

  try {
    actions = await scanServerActions(projectPath);
  } catch (error) {
    issues.push(
      makeIssue(
        "SA-SCAN-1",
        "server-actions",
        "warning",
        "Server actions scan failed",
        `Could not scan server actions: ${error instanceof Error ? error.message : String(error)}`,
        projectPath,
        null,
      ),
    );
    return {
      issues,
      actions: [],
      summary: { total: 0, withValidation: 0, withAuth: 0, withErrorHandling: 0 },
    };
  }

  if (actions.length === 0) {
    return {
      issues,
      actions: [],
      summary: { total: 0, withValidation: 0, withAuth: 0, withErrorHandling: 0 },
    };
  }

  // Audit each server action
  for (const action of actions) {
    const relPath = action.filePath.split("/").slice(-3).join("/");

    // Missing validation
    if (!action.hasValidation) {
      issues.push(
        makeIssue(
          `SA-VAL-${issues.length + 1}`,
          "server-actions",
          "warning",
          `Server action "${action.name}" lacks input validation`,
          `Server action "${action.name}" in ${relPath} does not use Zod or similar validation. User input from forms should always be validated on the server side.`,
          action.filePath,
          action.line,
        ),
      );
    }

    // Missing error handling
    if (!action.hasErrorHandling) {
      issues.push(
        makeIssue(
          `SA-ERR-${issues.length + 1}`,
          "server-actions",
          "warning",
          `Server action "${action.name}" lacks error handling`,
          `Server action "${action.name}" in ${relPath} does not have try/catch error handling. Unhandled errors in server actions surface as opaque "Server Error" messages to users.`,
          action.filePath,
          action.line,
        ),
      );
    }

    // Missing auth
    if (!action.hasAuth) {
      issues.push(
        makeIssue(
          `SA-AUTH-${issues.length + 1}`,
          "server-actions",
          "warning",
          `Server action "${action.name}" may lack auth checks`,
          `Server action "${action.name}" in ${relPath} does not appear to check authentication. Server actions are public endpoints — ensure they verify the user is authorized.`,
          action.filePath,
          action.line,
        ),
      );
    }

    // Database calls without error handling — critical
    if (action.hasDatabaseCalls && !action.hasErrorHandling) {
      issues.push(
        makeIssue(
          `SA-DB-${issues.length + 1}`,
          "server-actions",
          "critical",
          `Server action "${action.name}" has unprotected database calls`,
          `Server action "${action.name}" in ${relPath} makes database calls (${action.databaseCalls.slice(0, 3).join(", ")}) without try/catch. Database errors will crash the action and expose error details.`,
          action.filePath,
          action.line,
        ),
      );
    }
  }

  // Build summary
  const summary = {
    total: actions.length,
    withValidation: actions.filter((a) => a.hasValidation).length,
    withAuth: actions.filter((a) => a.hasAuth).length,
    withErrorHandling: actions.filter((a) => a.hasErrorHandling).length,
  };

  return { issues, actions, summary };
}

// ---------------------------------------------------------------------------
// Issue factory
// ---------------------------------------------------------------------------

/**
 * Creates a standardized Issue object.
 */
function makeIssue(
  id: string,
  category: IssueCategory,
  severity: Severity,
  title: string,
  description: string,
  file: string,
  line: number | null,
): Issue {
  return {
    id,
    category,
    severity,
    title,
    description,
    file,
    line,
    status: "open",
    firstSeen: new Date().toISOString(),
    fixedAt: null,
  };
}
