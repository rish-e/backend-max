// =============================================================================
// backend-max — Live endpoint testing (optional, GET-only in v1)
// =============================================================================

import type { EndpointTestResult, LiveTestOptions, LiveTestResult, RouteInfo } from "../types.js";
import { scanRoutes } from "./route-scanner.js";

/** Methods considered safe for automated testing (read-only). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Methods that are always skipped for safety (destructive or side-effect prone). */
const BLOCKED_METHODS = new Set(["DELETE"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the base URL points to a local address.
 */
function isLocalUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/**
 * Checks whether a response body contains error stack traces.
 */
function containsStackTrace(body: string): boolean {
  return (
    /at\s+\w+\s+\(/.test(body) ||
    /Error:\s+/.test(body) ||
    /\.js:\d+:\d+/.test(body) ||
    /\.ts:\d+:\d+/.test(body)
  );
}

/**
 * Determines if a route requires auth based on its method info.
 */
function routeRequiresAuth(route: RouteInfo, method: string): boolean {
  const methodInfo = route.methods.find((m) => m.method === method);
  return methodInfo?.hasAuth ?? false;
}

/**
 * Converts a URL pattern with dynamic segments into a testable URL.
 * Replaces [param] with a placeholder value for GET testing.
 */
function makeTestableUrl(baseUrl: string, urlPattern: string): string {
  // Replace dynamic segments with test values
  const testUrl = urlPattern
    .replace(/\[\[?\.\.\.\w+\]?\]/g, "test") // catch-all
    .replace(/\[(\w+)\]/g, "test-$1"); // single params

  return `${baseUrl.replace(/\/$/, "")}${testUrl}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs live HTTP tests against discovered API endpoints.
 *
 * **Safety rules:**
 * - Only GET/HEAD/OPTIONS endpoints are called with actual HTTP requests.
 * - POST/PUT/PATCH endpoints are skipped (no safe payload generation in v1).
 * - DELETE endpoints are **never** called.
 * - Non-localhost URLs require `allowRemote: true` in the base URL check.
 * - Timeouts are enforced per request.
 *
 * @param projectPath - Absolute path to the project root.
 * @param options     - Test configuration.
 * @returns Structured test results with per-endpoint details.
 */
export async function runLiveTests(
  projectPath: string,
  options: LiveTestOptions,
): Promise<LiveTestResult> {
  const { baseUrl, timeout = 5000, includeAuth = false, dryRun = false } = options;

  // Safety: require confirmation for non-local URLs
  if (!isLocalUrl(baseUrl)) {
    return {
      tested: [],
      skipped: [
        "All endpoints skipped — baseUrl is not localhost. Live testing only supports local URLs for safety.",
      ],
      summary: { total: 0, passed: 0, failed: 0, errors: 0 },
    };
  }

  // Scan routes to discover endpoints
  const scanResult = await scanRoutes(projectPath);
  const { routes } = scanResult;

  const tested: EndpointTestResult[] = [];
  const skipped: string[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const route of routes) {
    for (const methodInfo of route.methods) {
      const method = methodInfo.method;
      const endpointLabel = `${method} ${route.url}`;

      // Skip blocked methods (DELETE is never called)
      if (BLOCKED_METHODS.has(method)) {
        skipped.push(`${endpointLabel} — DELETE endpoints are never tested for safety`);
        continue;
      }

      // Skip auth-required endpoints unless includeAuth is set
      if (routeRequiresAuth(route, method) && !includeAuth) {
        skipped.push(`${endpointLabel} — requires auth (set includeAuth to test)`);
        continue;
      }

      // Skip non-safe methods (POST/PUT/PATCH) — can't generate payloads in v1
      if (!SAFE_METHODS.has(method)) {
        skipped.push(
          `${endpointLabel} — ${method} endpoints are skipped in v1 (no safe payload generation)`,
        );
        continue;
      }

      const testUrl = makeTestableUrl(baseUrl, route.url);

      // Dry run: just report what would be tested
      if (dryRun) {
        tested.push({
          url: testUrl,
          method,
          statusCode: null,
          responseTimeMs: 0,
          passed: true,
          issues: ["(dry run — not actually called)"],
        });
        passed++;
        continue;
      }

      // Actually call the endpoint
      const result = await testEndpoint(testUrl, method, timeout);
      tested.push(result);

      if (result.statusCode === null) {
        errors++;
      } else if (result.passed) {
        passed++;
      } else {
        failed++;
      }
    }
  }

  const total = tested.length;

  return {
    tested,
    skipped,
    summary: { total, passed, failed, errors },
  };
}

/**
 * Tests a single endpoint with a GET/HEAD/OPTIONS request.
 *
 * Checks:
 * - Status code is in 200-299 range
 * - Response time is under 2000ms
 * - JSON response is valid (if content-type says JSON)
 * - No stack traces leaked in response body
 */
async function testEndpoint(
  url: string,
  method: string,
  timeout: number,
): Promise<EndpointTestResult> {
  const issues: string[] = [];
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });

    clearTimeout(timer);
    const responseTimeMs = Date.now() - start;
    const statusCode = response.status;
    let bodyText = "";

    try {
      bodyText = await response.text();
    } catch {
      // Body read failure — non-fatal
    }

    // Check status code
    const statusOk = statusCode >= 200 && statusCode < 300;
    if (!statusOk) {
      issues.push(`Unexpected status code: ${statusCode}`);
    }

    // Check response time
    if (responseTimeMs > 2000) {
      issues.push(`Slow response: ${responseTimeMs}ms (threshold: 2000ms)`);
    }

    // Check JSON validity if content-type says JSON
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && bodyText.length > 0) {
      try {
        JSON.parse(bodyText);
      } catch {
        issues.push("Response has JSON content-type but body is not valid JSON");
      }
    }

    // Check for leaked stack traces
    if (bodyText.length > 0 && containsStackTrace(bodyText)) {
      issues.push("Response body appears to contain error stack traces");
    }

    return {
      url,
      method,
      statusCode,
      responseTimeMs,
      passed: statusOk && issues.length === 0,
      issues,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("abort")) {
      issues.push(`Request timed out after ${timeout}ms`);
    } else {
      issues.push(`Request failed: ${message}`);
    }

    return {
      url,
      method,
      statusCode: null,
      responseTimeMs,
      passed: false,
      issues,
    };
  }
}
