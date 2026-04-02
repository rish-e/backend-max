// =============================================================================
// backend-max — API versioning detection & audit
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Issue, RouteInfo } from "../types.js";
import { getTimestamp } from "../utils/helpers.js";
import { scanRoutes } from "./route-scanner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VersioningAuditResult {
  issues: Issue[];
  summary: string;
  /** Detected versioning strategy, if any. */
  strategy: "path" | "header" | "query" | "none";
  /** API versions detected (e.g., ["v1", "v2"]). */
  versions: string[];
  /** Routes grouped by version. */
  versionedRoutes: Record<string, string[]>;
  /** Routes that exist in one version but not another. */
  versionGaps: Array<{
    route: string;
    presentIn: string[];
    missingFrom: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects API versioning patterns and audits for consistency.
 */
export async function auditApiVersioning(projectPath: string): Promise<VersioningAuditResult> {
  const timestamp = getTimestamp();
  const issues: Issue[] = [];

  // 1. Scan routes
  let routes: RouteInfo[] = [];
  try {
    const scanResult = await scanRoutes(projectPath);
    routes = scanResult.routes;
  } catch {
    /* skip: route scan failure */
    return {
      issues: [],
      summary: "Could not scan routes for versioning analysis.",
      strategy: "none",
      versions: [],
      versionedRoutes: {},
      versionGaps: [],
    };
  }

  if (routes.length === 0) {
    return {
      issues: [],
      summary: "No routes found.",
      strategy: "none",
      versions: [],
      versionedRoutes: {},
      versionGaps: [],
    };
  }

  // 2. Detect versioning strategy
  const { strategy, versions, versionedRoutes } = await detectVersioning(routes, projectPath);

  // 3. If path-based versioning detected, check for consistency
  const versionGaps: VersioningAuditResult["versionGaps"] = [];

  if (strategy === "path" && versions.length >= 2) {
    // Normalize routes by stripping version prefix to compare
    const routesByVersion = new Map<string, Set<string>>();

    for (const [version, urls] of Object.entries(versionedRoutes)) {
      const normalizedRoutes = new Set(
        urls.map((url) =>
          url.replace(new RegExp(`^/(?:api/)?${version}/`), "/").replace(/^\/api\//, "/"),
        ),
      );
      routesByVersion.set(version, normalizedRoutes);
    }

    // Find routes that exist in some versions but not others
    const allNormalizedRoutes = new Set<string>();
    for (const routes of routesByVersion.values()) {
      for (const route of routes) allNormalizedRoutes.add(route);
    }

    for (const route of allNormalizedRoutes) {
      const presentIn: string[] = [];
      const missingFrom: string[] = [];

      for (const [version, routes] of routesByVersion) {
        if (routes.has(route)) presentIn.push(version);
        else missingFrom.push(version);
      }

      if (missingFrom.length > 0 && presentIn.length > 0) {
        versionGaps.push({ route, presentIn, missingFrom });
      }
    }

    // Generate issues for version gaps
    for (const gap of versionGaps) {
      const latestVersion = versions[versions.length - 1];
      const isNewInLatest =
        gap.presentIn.includes(latestVersion) && gap.missingFrom.every((v) => v !== latestVersion);

      if (!isNewInLatest) {
        // Route was removed in newer version — might be intentional deprecation
        issues.push({
          id: "",
          category: "contract",
          severity: "info",
          title: `Route ${gap.route} missing from ${gap.missingFrom.join(", ")}`,
          description:
            `This route exists in ${gap.presentIn.join(", ")} but not in ${gap.missingFrom.join(", ")}. ` +
            `If this is intentional deprecation, consider adding a deprecation response in the older version.`,
          file: join(projectPath, "package.json"),
          line: null,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }

    // Check for deprecated version still receiving traffic patterns
    if (versions.length >= 2) {
      const oldestVersion = versions[0];
      const oldRouteCount = versionedRoutes[oldestVersion]?.length ?? 0;
      const newestVersion = versions[versions.length - 1];
      const newRouteCount = versionedRoutes[newestVersion]?.length ?? 0;

      if (oldRouteCount > 0 && newRouteCount > 0) {
        issues.push({
          id: "",
          category: "contract",
          severity: "info",
          title: `Multiple API versions active: ${versions.join(", ")}`,
          description:
            `${versions.length} API versions detected. ${oldestVersion} has ${oldRouteCount} routes, ${newestVersion} has ${newRouteCount} routes. ` +
            `Consider adding deprecation headers (Sunset, Deprecation) to older version endpoints.`,
          file: join(projectPath, "package.json"),
          line: null,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }
  }

  // 4. Check for mixed versioning
  if (strategy === "none" && routes.length > 5) {
    // Check if SOME routes have version prefixes but not all
    const versionedCount = routes.filter((r) => /\/v\d+\//i.test(r.url)).length;
    if (versionedCount > 0 && versionedCount < routes.length) {
      issues.push({
        id: "",
        category: "contract",
        severity: "warning",
        title: "Inconsistent API versioning",
        description:
          `${versionedCount} of ${routes.length} routes use version prefixes (e.g., /v1/). ` +
          `Either version all API routes or none — mixed versioning causes confusion for consumers.`,
        file: join(projectPath, "package.json"),
        line: null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }
  }

  // 5. Check for header-based versioning patterns
  if (strategy === "header") {
    issues.push({
      id: "",
      category: "contract",
      severity: "info",
      title: "Header-based API versioning detected",
      description:
        "API versioning via headers (Accept, X-API-Version) was detected. Ensure all endpoints consistently check and document the version header.",
      file: join(projectPath, "package.json"),
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  const summary =
    strategy === "none"
      ? `No API versioning detected across ${routes.length} routes.`
      : `${strategy}-based versioning: ${versions.join(", ")}. ${versionGaps.length} version gap(s). ${issues.length} issue(s).`;

  return {
    issues,
    summary,
    strategy,
    versions,
    versionedRoutes,
    versionGaps,
  };
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

async function detectVersioning(
  routes: RouteInfo[],
  _projectPath: string,
): Promise<{
  strategy: VersioningAuditResult["strategy"];
  versions: string[];
  versionedRoutes: Record<string, string[]>;
}> {
  const versionedRoutes: Record<string, string[]> = {};

  // 1. Check for path-based versioning: /v1/..., /api/v1/..., /v2/...
  const versionRegex = /^(?:\/api)?\/v(\d+)\//i;
  const versionSet = new Set<string>();

  for (const route of routes) {
    const match = route.url.match(versionRegex);
    if (match) {
      const version = `v${match[1]}`;
      versionSet.add(version);
      if (!versionedRoutes[version]) versionedRoutes[version] = [];
      versionedRoutes[version].push(route.url);
    }
  }

  if (versionSet.size >= 1) {
    const versions = Array.from(versionSet).sort((a, b) => {
      const numA = parseInt(a.slice(1), 10);
      const numB = parseInt(b.slice(1), 10);
      return numA - numB;
    });

    return { strategy: "path", versions, versionedRoutes };
  }

  // 2. Check for header-based versioning patterns in source code
  // (look for Accept header or X-API-Version header checks)
  // This is a heuristic — we check if any route file references version headers
  let hasHeaderVersioning = false;
  for (const _route of routes) {
    try {
      // We don't read files here to avoid perf issues — just check URL patterns
    } catch {
      /* skip */
    }
  }

  // Check a few route files for header-based patterns
  const routeFiles = new Set(routes.map((r) => r.filePath));
  for (const filePath of Array.from(routeFiles).slice(0, 20)) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (/x-api-version|accept.*version|api-version/i.test(content)) {
        hasHeaderVersioning = true;
        break;
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  if (hasHeaderVersioning) {
    return { strategy: "header", versions: [], versionedRoutes: {} };
  }

  return { strategy: "none", versions: [], versionedRoutes: {} };
}
