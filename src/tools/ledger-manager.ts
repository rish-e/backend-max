// =============================================================================
// backend-max — Issue lifecycle ledger manager
// =============================================================================

import { join } from "node:path";
import type { Issue, LedgerEntry } from "../types.js";
import {
  ensureDir,
  readJsonSafe,
  writeJson,
  generateIssueId,
  getTimestamp,
} from "../utils/helpers.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** Ledger file name. */
const LEDGER_FILE = "ledger.json";

/** Summary returned after a ledger update. */
export interface LedgerUpdate {
  /** Issues that appeared for the first time in this scan. */
  newIssues: LedgerEntry[];
  /** Issues that were open but are no longer detected (now fixed). */
  fixedIssues: LedgerEntry[];
  /** Issues that were previously fixed but have reappeared. */
  regressions: LedgerEntry[];
  /** Total count of currently open issues. */
  totalOpen: number;
  /** Total count of fixed issues. */
  totalFixed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ledgerPath(projectPath: string): string {
  return join(projectPath, STATE_DIR, LEDGER_FILE);
}

/**
 * Converts a raw Issue into a full LedgerEntry with lifecycle fields.
 */
function issueToLedgerEntry(issue: Issue, now: string): LedgerEntry {
  return {
    ...issue,
    firstSeen: issue.firstSeen || now,
    fixedAt: null,
    lastSeen: now,
    occurrences: 1,
    hasRegressed: false,
    fingerprint: issue.id,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Updates the issue ledger with a new set of issues from a fresh scan.
 *
 * Lifecycle rules:
 * 1. New issue (ID not in ledger) -> add as "open".
 * 2. Existing "open" issue -> update details, bump occurrences.
 * 3. Previously "fixed" issue reappearing -> mark "regressed".
 * 4. Existing "open" issue NOT in new scan -> mark "fixed".
 *
 * @param projectPath - Absolute path to the project root.
 * @param newIssues   - Issues discovered in the latest scan.
 * @returns A LedgerUpdate summary.
 */
export async function updateLedger(
  projectPath: string,
  newIssues: Issue[],
): Promise<LedgerUpdate> {
  const dirPath = join(projectPath, STATE_DIR);
  await ensureDir(dirPath);

  const now = getTimestamp();
  const existing = await readJsonSafe<LedgerEntry[]>(ledgerPath(projectPath), []);

  // Index existing entries by ID for fast lookup
  const ledgerMap = new Map<string, LedgerEntry>();
  for (const entry of existing) {
    ledgerMap.set(entry.id, entry);
  }

  // Track which existing IDs appear in the new scan
  const seenIds = new Set<string>();

  const addedEntries: LedgerEntry[] = [];
  const regressionEntries: LedgerEntry[] = [];

  for (const issue of newIssues) {
    seenIds.add(issue.id);
    const prev = ledgerMap.get(issue.id);

    if (!prev) {
      // Brand new issue
      const entry = issueToLedgerEntry(issue, now);
      ledgerMap.set(issue.id, entry);
      addedEntries.push(entry);
    } else if (prev.status === "fixed") {
      // Regression — was fixed, now back
      prev.status = "regressed";
      prev.hasRegressed = true;
      prev.lastSeen = now;
      prev.occurrences += 1;
      prev.fixedAt = null;
      // Update possibly changed details
      prev.file = issue.file;
      prev.line = issue.line;
      prev.description = issue.description;
      regressionEntries.push(prev);
    } else {
      // Still open or ignored — update details
      prev.lastSeen = now;
      prev.occurrences += 1;
      prev.file = issue.file;
      prev.line = issue.line;
      prev.description = issue.description;
      prev.title = issue.title;
    }
  }

  // Issues that were "open" or "regressed" but not in the new scan -> fixed
  const fixedEntries: LedgerEntry[] = [];
  for (const entry of ledgerMap.values()) {
    if (!seenIds.has(entry.id) && (entry.status === "open" || entry.status === "regressed")) {
      entry.status = "fixed";
      entry.fixedAt = now;
      fixedEntries.push(entry);
    }
  }

  const ledgerArray = Array.from(ledgerMap.values());
  await writeJson(ledgerPath(projectPath), ledgerArray);

  const totalOpen = ledgerArray.filter(
    (e) => e.status === "open" || e.status === "regressed",
  ).length;
  const totalFixed = ledgerArray.filter((e) => e.status === "fixed").length;

  return {
    newIssues: addedEntries,
    fixedIssues: fixedEntries,
    regressions: regressionEntries,
    totalOpen,
    totalFixed,
  };
}

/**
 * Reads the ledger and returns entries matching the given filters.
 *
 * @param projectPath - Absolute path to the project root.
 * @param filter      - Optional filters for status, severity, and category.
 * @returns Filtered array of LedgerEntry objects.
 */
export async function getLedger(
  projectPath: string,
  filter: { status?: string; severity?: string; category?: string } = {},
): Promise<LedgerEntry[]> {
  const entries = await readJsonSafe<LedgerEntry[]>(ledgerPath(projectPath), []);

  return entries.filter((entry) => {
    if (filter.status && filter.status !== "all" && entry.status !== filter.status) {
      return false;
    }
    if (filter.severity && filter.severity !== "all" && entry.severity !== filter.severity) {
      return false;
    }
    if (filter.category && entry.category !== filter.category) {
      return false;
    }
    return true;
  });
}
