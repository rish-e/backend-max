// =============================================================================
// backend-max — Technical debt scorer
//
// Aggregates findings from all audit tools into a single technical debt
// score, estimates remediation effort, and tracks score over time.
// =============================================================================

import { join } from "node:path";
import type { Issue, Severity } from "../types.js";
import { ensureDir, readJsonSafe, writeJson, getTimestamp } from "../utils/helpers.js";

const STATE_DIR = ".backend-doctor";
const DEBT_FILE = "tech-debt-history.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DebtSnapshot {
  timestamp: string;
  score: number;
  totalIssues: number;
  criticalCount: number;
  warningCount: number;
}

export interface TechDebtResult {
  score: number;              // 0–100 (100 = no debt)
  grade: string;              // A+ / A / B / C / D / F
  totalIssues: number;
  breakdown: {
    category: string;
    issueCount: number;
    debtPoints: number;
    estimatedHours: number;
    topIssue: string | null;
  }[];
  estimatedTotalHours: number;
  trend: {
    direction: "improving" | "declining" | "stable" | "new";
    previousScore: number | null;
    delta: number;
    snapshotCount: number;
  };
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Effort estimates (hours per issue type/severity)
// ---------------------------------------------------------------------------

const EFFORT_HOURS: Record<Severity, number> = {
  critical: 4.0,
  bug:      2.0,
  warning:  1.0,
  info:     0.25,
};

const DEBT_POINTS: Record<Severity, number> = {
  critical: 10,
  bug:      6,
  warning:  3,
  info:     1,
};

// Category-specific multipliers (some categories are harder to fix)
const CATEGORY_MULTIPLIERS: Record<string, number> = {
  security:                1.5,
  auth:                    1.5,
  contract:                1.2,
  "contract-type-mismatch": 0.8,
  performance:             1.3,
  prisma:                  1.2,
  dependency:              0.7,  // Usually just version bumps
  env:                     0.5,  // Quick config fixes
  "error-handling":        1.0,
  validation:              1.0,
  "server-actions":        1.0,
  "rate-limit":            1.0,
  caching:                 0.8,
  versioning:              0.6,
  middleware:              1.0,
  graphql:                 1.2,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function scoreTechDebt(
  projectPath: string,
  issues: Issue[],
): Promise<TechDebtResult> {
  // Group issues by category
  const byCategory = new Map<string, Issue[]>();
  for (const issue of issues) {
    const cat = issue.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(issue);
  }

  // Calculate per-category breakdown
  const breakdown: TechDebtResult["breakdown"] = [];
  let totalDebtPoints = 0;
  let totalHours = 0;

  for (const [category, catIssues] of byCategory) {
    const multiplier = CATEGORY_MULTIPLIERS[category] ?? 1.0;
    let catPoints = 0;
    let catHours = 0;

    for (const issue of catIssues) {
      catPoints += DEBT_POINTS[issue.severity] * multiplier;
      catHours  += EFFORT_HOURS[issue.severity] * multiplier;
    }

    totalDebtPoints += catPoints;
    totalHours += catHours;

    // Find the worst issue in this category
    const sorted = [...catIssues].sort((a, b) => {
      const order: Record<string, number> = { critical: 0, bug: 1, warning: 2, info: 3 };
      return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
    });

    breakdown.push({
      category,
      issueCount: catIssues.length,
      debtPoints: Math.round(catPoints * 10) / 10,
      estimatedHours: Math.round(catHours * 10) / 10,
      topIssue: sorted[0]?.title ?? null,
    });
  }

  // Sort breakdown by debt points descending
  breakdown.sort((a, b) => b.debtPoints - a.debtPoints);

  // Calculate score (0–100, higher is better)
  // Score = 100 * e^(-totalDebtPoints / scaleFactor)
  // Scale factor chosen so that 50 debt points ≈ 70 score
  const scaleFactor = 120;
  const score = Math.round(100 * Math.exp(-totalDebtPoints / scaleFactor));

  // Grade
  const grade = scoreToGrade(score);

  // Generate recommendations (top 5)
  const recommendations = generateRecommendations(breakdown, issues);

  // Load history and compute trend
  const historyPath = join(projectPath, STATE_DIR, DEBT_FILE);
  const history = await readJsonSafe<DebtSnapshot[]>(historyPath, []);

  let trend: TechDebtResult["trend"];
  if (history.length === 0) {
    trend = { direction: "new", previousScore: null, delta: 0, snapshotCount: 0 };
  } else {
    const prev = history[history.length - 1];
    const delta = score - prev.score;
    trend = {
      direction: delta > 2 ? "improving" : delta < -2 ? "declining" : "stable",
      previousScore: prev.score,
      delta,
      snapshotCount: history.length,
    };
  }

  // Save current snapshot
  history.push({
    timestamp: getTimestamp(),
    score,
    totalIssues: issues.length,
    criticalCount: issues.filter((i) => i.severity === "critical").length,
    warningCount: issues.filter((i) => i.severity === "warning").length,
  });

  // Keep last 100 snapshots
  const trimmed = history.slice(-100);
  try {
    await ensureDir(join(projectPath, STATE_DIR));
    await writeJson(historyPath, trimmed);
  } catch {
    // Non-fatal
  }

  return {
    score,
    grade,
    totalIssues: issues.length,
    breakdown,
    estimatedTotalHours: Math.round(totalHours * 10) / 10,
    trend,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreToGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function generateRecommendations(
  breakdown: TechDebtResult["breakdown"],
  issues: Issue[],
): string[] {
  const recs: string[] = [];

  // Critical issues first
  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  if (criticalCount > 0) {
    recs.push(
      `Fix ${criticalCount} critical issue(s) immediately — these represent security risks or breaking changes.`,
    );
  }

  // Highest-debt category
  if (breakdown.length > 0) {
    const top = breakdown[0];
    recs.push(
      `Focus on ${top.category} (${top.issueCount} issues, ~${top.estimatedHours}h effort) — highest debt contributor.`,
    );
  }

  // Security
  const secIssues = issues.filter((i) => i.category === "security" || i.category === "auth");
  if (secIssues.length > 0) {
    recs.push(
      `Address ${secIssues.length} security/auth issue(s) before deploying to production.`,
    );
  }

  // Quick wins (info-level issues that are fast to fix)
  const quickWins = issues.filter((i) => i.severity === "info").length;
  if (quickWins > 5) {
    recs.push(
      `${quickWins} low-effort info issues can be batch-fixed to quickly improve the score.`,
    );
  }

  // Contract issues
  const contractIssues = issues.filter((i) => i.category === "contract" || i.category === "contract-type-mismatch");
  if (contractIssues.length > 0) {
    recs.push(
      `${contractIssues.length} frontend↔backend contract issue(s) — these can cause runtime errors for users.`,
    );
  }

  return recs.slice(0, 5);
}
