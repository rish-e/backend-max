// =============================================================================
// backend-max — Cross-project pattern learning (local-only, opt-in)
// =============================================================================

import { homedir } from "node:os";
import { join } from "node:path";
import type { Issue, PatternInsight, ProjectContext } from "../types.js";
import { ensureDir, readJsonSafe, writeJson } from "../utils/helpers.js";

/** Directory for cross-project pattern storage (user home, never project). */
const PATTERNS_DIR = join(homedir(), ".backend-max");
/** File where pattern data is persisted. */
const PATTERNS_FILE = join(PATTERNS_DIR, "patterns.json");

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A stored pattern entry. */
interface PatternEntry {
  /** Pattern identifier (e.g., "missing-auth-on-admin-route"). */
  pattern: string;
  /** Framework this pattern was found in. */
  framework: string;
  /** Total times this pattern has been seen. */
  occurrences: number;
  /** Number of distinct projects where this pattern has appeared. */
  projects: number;
  /** ISO timestamp when first seen. */
  firstSeen: string;
  /** ISO timestamp when last seen. */
  lastSeen: string;
  /** Set of project name hashes (for counting unique projects without storing names). */
  projectHashes: string[];
  /** Human-readable description of the pattern. */
  description: string;
}

/** Full pattern storage structure. */
interface PatternStore {
  version: number;
  patterns: PatternEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts an issue into a normalized pattern identifier.
 * Strips project-specific details to find the general pattern.
 */
function issueToPattern(issue: Issue): string {
  // Build pattern from category + normalized title
  const normalized = issue.title
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/\/api\/[\w/[\]-]+/g, "/api/ROUTE") // normalize route paths
    .replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, "MODEL") // normalize PascalCase (model names)
    .replace(/\b\w+\.ts\b/g, "FILE") // normalize filenames
    .replace(/\b\w+\.js\b/g, "FILE")
    .replace(/line\s+\d+/g, "line N") // normalize line numbers
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `${issue.category}-${normalized}`.slice(0, 80);
}

/**
 * Generates a simple hash of a project name for anonymous tracking.
 * We don't store actual project names — just need to count unique projects.
 */
function hashProjectName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generates a human-readable description for a pattern based on its issue.
 */
function generateDescription(issue: Issue): string {
  const categoryLabels: Record<string, string> = {
    contract: "Frontend-backend contract mismatch",
    "contract-type-mismatch": "Type mismatch between frontend and backend",
    "error-handling": "Missing or insufficient error handling",
    validation: "Missing input validation",
    env: "Environment variable issue",
    security: "Security concern",
    performance: "Performance anti-pattern",
    nextjs: "Next.js configuration issue",
    auth: "Authentication/authorization gap",
    prisma: "Database schema issue",
    "server-actions": "Server action issue",
  };

  return categoryLabels[issue.category] ?? issue.title;
}

/**
 * Loads the pattern store from disk, returning a default if missing.
 */
async function loadStore(): Promise<PatternStore> {
  return readJsonSafe<PatternStore>(PATTERNS_FILE, {
    version: 1,
    patterns: [],
  });
}

/**
 * Saves the pattern store to disk.
 */
async function saveStore(store: PatternStore): Promise<void> {
  await ensureDir(PATTERNS_DIR);
  await writeJson(PATTERNS_FILE, store);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tracks patterns from a set of diagnosed issues.
 *
 * For each issue, the function:
 * 1. Extracts a normalized pattern identifier (stripped of project-specific details).
 * 2. Looks up or creates an entry in `~/.backend-max/patterns.json`.
 * 3. Increments occurrence counts and updates timestamps.
 *
 * Storage is LOCAL ONLY — never sent anywhere.
 *
 * @param issues         - Issues from the current diagnosis.
 * @param projectContext - Context of the project being diagnosed.
 */
export async function trackPatterns(
  issues: Issue[],
  projectContext: ProjectContext,
): Promise<void> {
  if (issues.length === 0) return;

  const store = await loadStore();
  const now = new Date().toISOString();
  const projectHash = hashProjectName(projectContext.name);

  // Build a lookup map for existing patterns
  const patternMap = new Map<string, PatternEntry>();
  for (const entry of store.patterns) {
    patternMap.set(entry.pattern, entry);
  }

  for (const issue of issues) {
    const pattern = issueToPattern(issue);
    const existing = patternMap.get(pattern);

    if (existing) {
      existing.occurrences++;
      existing.lastSeen = now;
      if (!existing.projectHashes.includes(projectHash)) {
        existing.projectHashes.push(projectHash);
        existing.projects = existing.projectHashes.length;
      }
    } else {
      const entry: PatternEntry = {
        pattern,
        framework: projectContext.framework,
        occurrences: 1,
        projects: 1,
        firstSeen: now,
        lastSeen: now,
        projectHashes: [projectHash],
        description: generateDescription(issue),
      };
      patternMap.set(pattern, entry);
    }
  }

  store.patterns = Array.from(patternMap.values());
  await saveStore(store);
}

/**
 * Returns the most common patterns for a given framework, sorted by frequency.
 *
 * @param framework - Framework to filter by (e.g., "nextjs", "express").
 *                    Use "all" or empty string for all frameworks.
 * @returns Array of pattern insights sorted by occurrence count (descending).
 */
export async function getCommonPatterns(framework: string): Promise<PatternInsight[]> {
  const store = await loadStore();
  const normalizedFramework = framework.toLowerCase().trim();

  const filtered =
    normalizedFramework && normalizedFramework !== "all"
      ? store.patterns.filter((p) => p.framework.toLowerCase() === normalizedFramework)
      : store.patterns;

  return filtered
    .sort((a, b) => b.occurrences - a.occurrences)
    .map((p) => ({
      pattern: p.pattern,
      occurrences: p.occurrences,
      projects: p.projects,
      framework: p.framework,
      description: p.description,
    }));
}

/**
 * Compares current issues against known patterns and returns human-readable
 * insights about how common each issue is across projects.
 *
 * @param issues - Issues from the current diagnosis.
 * @returns Array of insight strings.
 */
export async function getProjectInsights(issues: Issue[]): Promise<string[]> {
  if (issues.length === 0) return [];

  const store = await loadStore();
  if (store.patterns.length === 0) {
    return [
      "No cross-project pattern data available yet. Patterns will be tracked after each diagnosis.",
    ];
  }

  // Build lookup
  const patternMap = new Map<string, PatternEntry>();
  for (const entry of store.patterns) {
    patternMap.set(entry.pattern, entry);
  }

  // Sort all patterns by occurrences to get rankings
  const sortedPatterns = [...store.patterns].sort((a, b) => b.occurrences - a.occurrences);
  const rankMap = new Map<string, number>();
  sortedPatterns.forEach((p, idx) => rankMap.set(p.pattern, idx + 1));

  const insights: string[] = [];
  const totalProjects = new Set(store.patterns.flatMap((p) => p.projectHashes)).size;

  for (const issue of issues) {
    const pattern = issueToPattern(issue);
    const entry = patternMap.get(pattern);

    if (entry && entry.projects > 1) {
      const rank = rankMap.get(pattern) ?? 0;
      const projectPct = totalProjects > 0 ? Math.round((entry.projects / totalProjects) * 100) : 0;

      if (rank <= 3) {
        insights.push(
          `"${issue.title}" is the #${rank} most common issue — found in ${projectPct}% of projects (${entry.projects} projects, ${entry.occurrences} total occurrences).`,
        );
      } else if (entry.occurrences >= 3) {
        insights.push(
          `"${issue.title}" has been seen ${entry.occurrences} times across ${entry.projects} projects.`,
        );
      }
    }
  }

  if (insights.length === 0) {
    insights.push(
      "No cross-project pattern matches found for the current issues. This project may have unique patterns.",
    );
  }

  return insights;
}
