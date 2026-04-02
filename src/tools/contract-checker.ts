// =============================================================================
// backend-max — Contract Checker
//
// Cross-references frontend API calls against backend route definitions to
// detect dead endpoints, phantom calls, and method mismatches.
// =============================================================================

import { scanFrontendCalls, traceResponseUsage } from "../analyzers/frontend.js";
import type { ContractMismatch, ContractResult, RouteInfo } from "../types.js";
import { scanRoutes } from "./route-scanner.js";

// ---------------------------------------------------------------------------
// URL normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Strip trailing slashes and lowercase the path for comparison.
 * Dynamic segments like `[id]`, `[slug]`, `{id}`, or `${something}` are
 * replaced with a canonical `:param` placeholder so both sides match.
 */
function normalizeUrl(url: string): string {
  let normalized =
    url
      // Remove query strings and hashes
      .replace(/[?#].*$/, "")
      // Remove trailing slash (but keep root "/")
      .replace(/\/+$/, "") || "/";

  // Replace Next.js dynamic params: [id], [slug], [...params]
  normalized = normalized.replace(/\[\.{3}(\w+)\]/g, ":$1");
  normalized = normalized.replace(/\[(\w+)\]/g, ":$1");

  // Replace template literal interpolations: ${id}, ${user.id}
  normalized = normalized.replace(/\$\{[^}]+\}/g, ":param");

  // Replace Express-style params: :id (leave as-is, already canonical)

  // Replace {id} style params (OpenAPI / other frameworks)
  normalized = normalized.replace(/\{(\w+)\}/g, ":$1");

  return normalized.toLowerCase();
}

/**
 * Check whether two normalised URLs match, treating `:param` segments as
 * wildcards that match any single path segment.
 */
function urlsMatch(a: string, b: string): boolean {
  const partsA = a.split("/");
  const partsB = b.split("/");

  if (partsA.length !== partsB.length) return false;

  return partsA.every((segA, i) => {
    const segB = partsB[i];
    if (segA.startsWith(":") || segB.startsWith(":")) return true;
    return segA === segB;
  });
}

/**
 * Find the backend route (if any) whose URL pattern matches a frontend call.
 */
function findMatchingRoute(normalizedFrontendUrl: string, routes: RouteInfo[]): RouteInfo | null {
  for (const route of routes) {
    if (urlsMatch(normalizedFrontendUrl, normalizeUrl(route.url))) {
      return route;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check frontend-backend contracts.
 *
 * 1. Scans all backend routes via `scanRoutes()`.
 * 2. Scans all frontend API calls via `scanFrontendCalls()`.
 * 3. Cross-references them to detect:
 *    - **Dead endpoints** -- backend routes not called by any frontend code.
 *    - **Phantom calls** -- frontend calls to endpoints that don't exist.
 *    - **Method mismatches** -- e.g. frontend sends POST but backend only
 *      exposes GET.
 *
 * @param projectPath Absolute path to the project root.
 * @returns A `ContractResult` with all detected mismatches and summary counts.
 */
export async function checkContracts(projectPath: string): Promise<ContractResult> {
  const mismatches: ContractMismatch[] = [];
  let matchedCount = 0;

  // --- Step 1 & 2: gather data from both sides ---------------------------

  const scanResult = await scanRoutes(projectPath);
  const routes = scanResult.routes;

  const frontendCalls = await scanFrontendCalls(projectPath);

  // Track which routes are referenced by at least one frontend call.
  const referencedRoutes = new Set<string>();

  // --- Step 3: cross-reference -------------------------------------------

  for (const call of frontendCalls) {
    const normalizedCallUrl = normalizeUrl(call.url);
    const matchingRoute = findMatchingRoute(normalizedCallUrl, routes);

    if (!matchingRoute) {
      // Phantom call: frontend calls an endpoint that doesn't exist.
      mismatches.push({
        frontendCall: call,
        closestRoute: findClosestRoute(normalizedCallUrl, routes),
        reason: `Phantom call: frontend calls ${call.method} ${call.url} but no matching backend route exists.`,
        severity: "critical",
      });
      continue;
    }

    // Mark route as referenced.
    referencedRoutes.add(matchingRoute.filePath);

    // Check method match.
    const backendMethods = matchingRoute.methods.map((m) => m.method.toUpperCase());
    const frontendMethod = call.method.toUpperCase();

    if (!backendMethods.includes(frontendMethod)) {
      mismatches.push({
        frontendCall: call,
        closestRoute: matchingRoute,
        reason: `Method mismatch: frontend calls ${frontendMethod} ${call.url} but backend only exports [${backendMethods.join(", ")}].`,
        severity: "warning",
      });
      continue;
    }

    // Successful match.
    matchedCount++;
  }

  // Dead endpoints: routes never called by any frontend code.
  for (const route of routes) {
    if (!referencedRoutes.has(route.filePath)) {
      // Create a synthetic frontend call to represent the dead endpoint.
      for (const method of route.methods) {
        mismatches.push({
          frontendCall: {
            url: route.url,
            method: method.method,
            file: "",
            line: 0,
            expectedType: null,
          },
          closestRoute: route,
          reason: `Dead endpoint: ${method.method.toUpperCase()} ${route.url} is defined in ${route.filePath} but never called by frontend code.`,
          severity: "info",
        });
      }
    }
  }

  // --- Step 4: type flow analysis -------------------------------------------

  try {
    const typeFlowIssues = await traceResponseUsage(projectPath, frontendCalls);
    for (const tfi of typeFlowIssues) {
      // Find the matching route for this type flow issue
      const normalizedUrl = normalizeUrl(tfi.backendRoute);
      const matchingRoute = findMatchingRoute(normalizedUrl, routes);

      mismatches.push({
        frontendCall: {
          url: tfi.backendRoute,
          method: "GET",
          file: tfi.frontendFile,
          line: tfi.frontendLine,
          expectedType: tfi.expectedProperty,
        },
        closestRoute: matchingRoute,
        reason: `Type flow: ${tfi.description}`,
        severity: "info",
      });
    }
  } catch (e) {
    console.error(
      "[contract-checker] Type flow analysis skipped:",
      e instanceof Error ? e.message : e,
    );
  }

  return {
    mismatches,
    matchedCount,
    unmatchedCount: mismatches.length,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the route with the most similar URL to the given path (for helpful
 * error messages). Uses a simple segment-overlap heuristic.
 */
function findClosestRoute(normalizedUrl: string, routes: RouteInfo[]): RouteInfo | null {
  if (routes.length === 0) return null;

  const targetParts = normalizedUrl.split("/");
  let bestRoute: RouteInfo | null = null;
  let bestScore = -1;

  for (const route of routes) {
    const routeParts = normalizeUrl(route.url).split("/");
    let score = 0;

    const len = Math.min(targetParts.length, routeParts.length);
    for (let i = 0; i < len; i++) {
      if (
        targetParts[i] === routeParts[i] ||
        targetParts[i].startsWith(":") ||
        routeParts[i].startsWith(":")
      ) {
        score++;
      }
    }

    // Penalise length differences.
    score -= Math.abs(targetParts.length - routeParts.length);

    if (score > bestScore) {
      bestScore = score;
      bestRoute = route;
    }
  }

  return bestRoute;
}
