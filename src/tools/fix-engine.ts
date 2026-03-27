// =============================================================================
// backend-max — Fix engine (v1 stub)
// =============================================================================

import { join } from "node:path";
import type { LedgerEntry } from "../types.js";
import { readJsonSafe, writeJson } from "../utils/helpers.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** Ledger file name. */
const LEDGER_FILE = "ledger.json";

/** Result of attempting to fix an issue. */
export interface FixResult {
  /** Whether the fix was applied (always false in v1 — describe-only). */
  success: boolean;
  /** Human-readable message about the fix or error. */
  message: string;
  /** Description of what would change (v1 does not produce actual diffs). */
  diff?: string;
}

// ---------------------------------------------------------------------------
// Category-specific fix descriptions
// ---------------------------------------------------------------------------

const FIX_TEMPLATES: Record<string, (entry: LedgerEntry) => string> = {
  "error-handling": (entry) =>
    `Wrap the handler at ${entry.file}:${entry.line ?? "?"} in a try/catch block and return a structured JSON error response with an appropriate HTTP status code.`,

  validation: (entry) =>
    `Add input validation (e.g. Zod schema) to the handler at ${entry.file}:${entry.line ?? "?"}. Parse and validate the request body/params before processing.`,

  contract: (entry) =>
    `The frontend expects an endpoint that doesn't match the backend. Verify the URL and HTTP method at ${entry.file}:${entry.line ?? "?"} match what the backend exposes.`,

  env: (entry) =>
    `Ensure the environment variable referenced at ${entry.file}:${entry.line ?? "?"} is defined in your .env file and has a sensible default or runtime check.`,

  security: (entry) =>
    `Add authentication/authorization middleware to the route at ${entry.file}:${entry.line ?? "?"}. Ensure the endpoint is protected before accessing sensitive data.`,

  performance: (entry) =>
    `Optimize the database query at ${entry.file}:${entry.line ?? "?"}. Consider adding pagination, limiting selected fields, or batching related queries.`,

  nextjs: (entry) =>
    `Review the Next.js route handler at ${entry.file}:${entry.line ?? "?"} for framework-specific issues. Check dynamic route parameters and response helpers.`,

  auth: (entry) =>
    `Fix the authentication issue at ${entry.file}:${entry.line ?? "?"}. Ensure session/token validation is properly configured.`,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Looks up an issue by ID and returns a description of the proposed fix.
 *
 * In v1 this is a stub — it does NOT modify any source files. It reads the
 * ledger, locates the issue, generates a human-readable fix description,
 * and marks the issue as "ignored" (acknowledged) in the ledger.
 *
 * @param projectPath - Absolute path to the project root.
 * @param issueId     - The deterministic issue ID (e.g. "ERR-a1b2c3").
 * @returns A FixResult describing what should change.
 */
export async function fixIssue(
  projectPath: string,
  issueId: string,
): Promise<FixResult> {
  const ledgerFilePath = join(projectPath, STATE_DIR, LEDGER_FILE);
  const ledger = await readJsonSafe<LedgerEntry[]>(ledgerFilePath, []);

  // Find the issue
  const entry = ledger.find((e) => e.id === issueId);

  if (!entry) {
    return {
      success: false,
      message: `Issue "${issueId}" not found in the ledger. Run a diagnosis first to populate the ledger.`,
    };
  }

  if (entry.status === "fixed") {
    return {
      success: false,
      message: `Issue "${issueId}" is already marked as fixed (fixed at ${entry.fixedAt}).`,
    };
  }

  // Generate fix description
  const template = FIX_TEMPLATES[entry.category];
  const fixDescription = template
    ? template(entry)
    : `Review and fix the issue at ${entry.file}:${entry.line ?? "?"}: ${entry.description}`;

  // Build a pseudo-diff for context
  const diff = [
    `--- Issue: ${entry.id} (${entry.category})`,
    `--- File: ${entry.file}`,
    `--- Line: ${entry.line ?? "unknown"}`,
    `--- Severity: ${entry.severity}`,
    ``,
    `Problem: ${entry.title}`,
    `${entry.description}`,
    ``,
    `Proposed fix:`,
    fixDescription,
  ].join("\n");

  // Mark as acknowledged (ignored) in the ledger — v1 doesn't actually fix
  entry.status = "ignored";
  await writeJson(ledgerFilePath, ledger);

  return {
    success: true,
    message: `Fix proposal generated for "${entry.title}". The issue has been acknowledged in the ledger. Actual code modification will be available in v2.`,
    diff,
  };
}
