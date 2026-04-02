// =============================================================================
// backend-max — API breaking change detector
//
// Compares current route definitions against a saved baseline snapshot to
// detect removed endpoints, changed response shapes, renamed fields, etc.
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Issue, IssueCategory, RouteInfo, ScanResult } from "../types.js";
import { ensureDir, generateIssueId, readJsonSafe, writeJson } from "../utils/helpers.js";
import { scanRoutes } from "./route-scanner.js";

const CATEGORY: IssueCategory = "versioning";
const STATE_DIR = ".backend-doctor";
const BASELINE_FILE = "api-baseline.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BaselineRoute {
  url: string;
  methods: string[];
  dynamicParams: string[];
  methodDetails: Record<string, {
    hasValidation: boolean;
    hasAuth: boolean;
    returnType: string | null;
  }>;
}

interface BaselineSnapshot {
  timestamp: string;
  routes: BaselineRoute[];
  version: string;
}

interface BreakingChange {
  type: "removed" | "method-removed" | "param-changed" | "validation-removed" | "auth-removed" | "return-type-changed";
  route: string;
  detail: string;
  severity: "critical" | "warning";
}

export interface BreakingChangesResult {
  issues: Issue[];
  changes: BreakingChange[];
  summary: {
    totalBreaking: number;
    removedEndpoints: number;
    removedMethods: number;
    paramChanges: number;
    validationRemovals: number;
    authRemovals: number;
    baselineExists: boolean;
    baselineTimestamp: string | null;
  };
  baselineSaved: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare current API surface against a saved baseline.
 * If no baseline exists, saves the current state as baseline and returns no issues.
 *
 * @param projectPath  Absolute path to the project root.
 * @param saveBaseline If true, saves the current state as the new baseline after comparison.
 */
export async function auditBreakingChanges(
  projectPath: string,
  saveBaseline: boolean = false,
): Promise<BreakingChangesResult> {
  const issues: Issue[] = [];
  const changes: BreakingChange[] = [];

  // Scan current routes
  let scanResult: ScanResult;
  try {
    scanResult = await scanRoutes(projectPath);
  } catch (error) {
    return {
      issues: [{
        id: generateIssueId(CATEGORY, projectPath, "scan-failed"),
        category: CATEGORY,
        severity: "warning",
        title: "Breaking change detection failed — could not scan routes",
        description: `Route scanning failed: ${error instanceof Error ? error.message : String(error)}`,
        file: projectPath,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      }],
      changes: [],
      summary: {
        totalBreaking: 0, removedEndpoints: 0, removedMethods: 0,
        paramChanges: 0, validationRemovals: 0, authRemovals: 0,
        baselineExists: false, baselineTimestamp: null,
      },
      baselineSaved: false,
    };
  }

  const currentRoutes = routesToBaseline(scanResult.routes);
  const baselinePath = join(projectPath, STATE_DIR, BASELINE_FILE);

  // Load existing baseline
  const baseline = await readJsonSafe<BaselineSnapshot | null>(baselinePath, null);

  if (!baseline) {
    // No baseline — save current and return
    await saveBaselineSnapshot(projectPath, currentRoutes);
    return {
      issues: [],
      changes: [],
      summary: {
        totalBreaking: 0, removedEndpoints: 0, removedMethods: 0,
        paramChanges: 0, validationRemovals: 0, authRemovals: 0,
        baselineExists: false, baselineTimestamp: null,
      },
      baselineSaved: true,
    };
  }

  // Compare baseline vs current
  const currentMap = new Map(currentRoutes.map((r) => [r.url, r]));
  const baselineMap = new Map(baseline.routes.map((r) => [r.url, r]));

  let removedEndpoints = 0;
  let removedMethods = 0;
  let paramChanges = 0;
  let validationRemovals = 0;
  let authRemovals = 0;

  // Check for removed or changed routes
  for (const [url, baseRoute] of baselineMap) {
    const currRoute = currentMap.get(url);

    if (!currRoute) {
      // Entire endpoint removed
      removedEndpoints++;
      const change: BreakingChange = {
        type: "removed",
        route: url,
        detail: `Endpoint ${url} existed in baseline but is now missing. Methods: ${baseRoute.methods.join(", ")}`,
        severity: "critical",
      };
      changes.push(change);
      issues.push({
        id: generateIssueId(CATEGORY, url, "endpoint-removed"),
        category: CATEGORY,
        severity: "critical",
        title: `BREAKING: Endpoint removed — ${url}`,
        description: change.detail,
        file: url,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
      continue;
    }

    // Check for removed methods
    for (const method of baseRoute.methods) {
      if (!currRoute.methods.includes(method)) {
        removedMethods++;
        const change: BreakingChange = {
          type: "method-removed",
          route: url,
          detail: `${method} ${url} existed in baseline but is now missing.`,
          severity: "critical",
        };
        changes.push(change);
        issues.push({
          id: generateIssueId(CATEGORY, url, `method-removed-${method}`),
          category: CATEGORY,
          severity: "critical",
          title: `BREAKING: ${method} handler removed — ${url}`,
          description: change.detail,
          file: url,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }

    // Check for dynamic param changes
    const baseParams = baseRoute.dynamicParams.sort().join(",");
    const currParams = currRoute.dynamicParams.sort().join(",");
    if (baseParams !== currParams && baseParams.length > 0) {
      paramChanges++;
      const change: BreakingChange = {
        type: "param-changed",
        route: url,
        detail: `Dynamic params changed: [${baseParams}] → [${currParams}]`,
        severity: "warning",
      };
      changes.push(change);
      issues.push({
        id: generateIssueId(CATEGORY, url, "param-changed"),
        category: CATEGORY,
        severity: "warning",
        title: `Parameter change detected — ${url}`,
        description: change.detail,
        file: url,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }

    // Check for validation/auth removals (regressions)
    for (const method of baseRoute.methods) {
      const baseDetail = baseRoute.methodDetails[method];
      const currDetail = currRoute.methodDetails[method];
      if (!baseDetail || !currDetail) continue;

      if (baseDetail.hasValidation && !currDetail.hasValidation) {
        validationRemovals++;
        changes.push({
          type: "validation-removed",
          route: url,
          detail: `${method} ${url} had input validation in baseline but no longer does.`,
          severity: "warning",
        });
        issues.push({
          id: generateIssueId(CATEGORY, url, `validation-removed-${method}`),
          category: CATEGORY,
          severity: "warning",
          title: `Validation removed — ${method} ${url}`,
          description: `Input validation was present in baseline but has been removed. This may expose the endpoint to invalid input.`,
          file: url,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }

      if (baseDetail.hasAuth && !currDetail.hasAuth) {
        authRemovals++;
        changes.push({
          type: "auth-removed",
          route: url,
          detail: `${method} ${url} had auth protection in baseline but no longer does.`,
          severity: "critical",
        });
        issues.push({
          id: generateIssueId(CATEGORY, url, `auth-removed-${method}`),
          category: CATEGORY,
          severity: "critical",
          title: `BREAKING: Auth removed — ${method} ${url}`,
          description: `Authentication check was present in baseline but has been removed. This endpoint may now be unprotected.`,
          file: url,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }
  }

  // Optionally save new baseline
  let baselineSaved = false;
  if (saveBaseline) {
    await saveBaselineSnapshot(projectPath, currentRoutes);
    baselineSaved = true;
  }

  return {
    issues,
    changes,
    summary: {
      totalBreaking: changes.length,
      removedEndpoints,
      removedMethods,
      paramChanges,
      validationRemovals,
      authRemovals,
      baselineExists: true,
      baselineTimestamp: baseline.timestamp,
    },
    baselineSaved,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routesToBaseline(routes: RouteInfo[]): BaselineRoute[] {
  return routes.map((r) => ({
    url: r.url,
    methods: r.methods.map((m) => m.method),
    dynamicParams: r.dynamicParams,
    methodDetails: Object.fromEntries(
      r.methods.map((m) => [m.method, {
        hasValidation: m.hasValidation,
        hasAuth: m.hasAuth,
        returnType: m.returnType,
      }]),
    ),
  }));
}

async function saveBaselineSnapshot(
  projectPath: string,
  routes: BaselineRoute[],
): Promise<void> {
  const dir = join(projectPath, STATE_DIR);
  await ensureDir(dir);
  const snapshot: BaselineSnapshot = {
    timestamp: new Date().toISOString(),
    routes,
    version: "1.0.0",
  };
  await writeJson(join(dir, BASELINE_FILE), snapshot);
}
