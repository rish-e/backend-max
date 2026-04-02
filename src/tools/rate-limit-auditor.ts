// =============================================================================
// backend-max — Rate limiting & caching audit
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import type { Issue, RouteInfo } from "../types.js";
import { getTimestamp } from "../utils/helpers.js";
import { scanRoutes } from "./route-scanner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitAuditResult {
  issues: Issue[];
  summary: string;
  hasRateLimiting: boolean;
  hasCaching: boolean;
  rateLimitPackages: string[];
  cachePackages: string[];
}

// ---------------------------------------------------------------------------
// Known packages
// ---------------------------------------------------------------------------

const RATE_LIMIT_PACKAGES = [
  "express-rate-limit",
  "rate-limiter-flexible",
  "@fastify/rate-limit",
  "hono-rate-limiter",
  "upstash-ratelimit",
  "@upstash/ratelimit",
  "bottleneck",
  "p-throttle",
  "limiter",
];

const CACHE_PACKAGES = [
  "ioredis",
  "redis",
  "@upstash/redis",
  "lru-cache",
  "node-cache",
  "keyv",
  "cacheable-request",
  "apicache",
  "@fastify/caching",
  "memory-cache",
  "flat-cache",
];

/** Patterns indicating rate limiting in code. */
const RATE_LIMIT_CODE_PATTERNS = [
  /rateLimit\s*\(/i,
  /rateLimiter/i,
  /RateLimiterMemory|RateLimiterRedis/,
  /X-RateLimit/i,
  /retry-after/i,
  /slidingWindow|fixedWindow|tokenBucket/i,
  /\.rateLimit\s*\(/,
  /Ratelimit\s*\(/,
];

/** Patterns indicating caching in code. */
const CACHE_CODE_PATTERNS = [
  /cache-control/i,
  /s-maxage|max-age|stale-while-revalidate/i,
  /\.setHeader\s*\(\s*['"`]Cache/i,
  /headers\s*\(\s*\{[^}]*cache/i,
  /redis\.get|redis\.set/i,
  /cache\.get|cache\.set/i,
  /lru\.get|lru\.set/i,
  /\.cache\s*\(/,
  /unstable_cache|revalidate/,
  /next\.revalidate/,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audits rate limiting and caching patterns in the project.
 */
export async function auditRateLimitAndCaching(projectPath: string): Promise<RateLimitAuditResult> {
  const timestamp = getTimestamp();
  const issues: Issue[] = [];

  // 1. Check package.json for rate limiting / caching packages
  const { rateLimitPkgs, cachePkgs } = await checkPackages(projectPath);

  // 2. Scan source files for rate limiting / caching patterns
  const { hasRateLimitCode, hasCacheCode, filePatterns } = await scanCodePatterns(projectPath);

  const hasRateLimiting = rateLimitPkgs.length > 0 || hasRateLimitCode;
  const hasCaching = cachePkgs.length > 0 || hasCacheCode;

  // 3. Scan routes and identify expensive endpoints without protection
  let routes: RouteInfo[] = [];
  try {
    const scanResult = await scanRoutes(projectPath);
    routes = scanResult.routes;
  } catch (e) {
    console.error("[rate-limit-auditor] Route scan failed:", e instanceof Error ? e.message : e);
  }

  // 4. Check for expensive endpoints without rate limiting
  if (!hasRateLimiting && routes.length > 0) {
    // Find auth-related endpoints (login, register, forgot-password) — these MUST be rate limited
    const authEndpoints = routes.filter((r) =>
      /login|signin|sign-in|register|signup|sign-up|forgot|reset|password|verify|otp|token/i.test(
        r.url,
      ),
    );

    for (const route of authEndpoints) {
      issues.push({
        id: "",
        category: "security",
        severity: "critical",
        title: `Auth endpoint without rate limiting: ${route.url}`,
        description:
          "Authentication endpoints are prime targets for brute-force attacks. Add rate limiting with express-rate-limit, @upstash/ratelimit, or similar.",
        file: route.filePath,
        line: route.methods[0]?.lineNumber ?? null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }

    // General warning if no rate limiting at all
    if (authEndpoints.length === 0) {
      issues.push({
        id: "",
        category: "security",
        severity: "warning",
        title: "No rate limiting detected",
        description:
          "No rate limiting package or code patterns found. Add rate limiting to protect against abuse, especially on auth and mutation endpoints.",
        file: join(projectPath, "package.json"),
        line: null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }
  }

  // 5. Check for expensive endpoints without caching
  const expensiveEndpoints = routes.filter((r) =>
    r.methods.some((m) => m.method === "GET" && m.hasDatabaseCalls),
  );

  if (!hasCaching && expensiveEndpoints.length > 3) {
    issues.push({
      id: "",
      category: "performance",
      severity: "warning",
      title: `${expensiveEndpoints.length} GET endpoints with DB calls but no caching`,
      description:
        "Multiple GET endpoints make database calls but no caching layer was detected. Consider adding response caching with Cache-Control headers, Redis, or Next.js revalidation.",
      file: expensiveEndpoints[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  // 6. Check for missing Cache-Control headers on static-like endpoints
  for (const route of routes) {
    if (/\/api\/(?:config|settings|metadata|manifest|health|status)/i.test(route.url)) {
      const routeContent = await safeReadFile(route.filePath);
      if (routeContent && !/cache-control|s-maxage|max-age|revalidate/i.test(routeContent)) {
        issues.push({
          id: "",
          category: "performance",
          severity: "info",
          title: `Cacheable endpoint missing Cache-Control: ${route.url}`,
          description:
            "This endpoint serves relatively static data but doesn't set Cache-Control headers. Add appropriate caching headers to reduce server load.",
          file: route.filePath,
          line: null,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }
  }

  const summaryParts = [
    `Rate limiting: ${hasRateLimiting ? "detected" : "NOT detected"}.`,
    `Caching: ${hasCaching ? "detected" : "NOT detected"}.`,
    `${issues.length} issue(s) found.`,
  ];

  return {
    issues,
    summary: summaryParts.join(" "),
    hasRateLimiting,
    hasCaching,
    rateLimitPackages: rateLimitPkgs,
    cachePackages: cachePkgs,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkPackages(projectPath: string): Promise<{
  rateLimitPkgs: string[];
  cachePkgs: string[];
}> {
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object") return { rateLimitPkgs: [], cachePkgs: [] };
    const allDeps = {
      ...(pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {}),
      ...(pkg.devDependencies && typeof pkg.devDependencies === "object"
        ? pkg.devDependencies
        : {}),
    };

    const rateLimitPkgs = RATE_LIMIT_PACKAGES.filter((p) => p in allDeps);
    const cachePkgs = CACHE_PACKAGES.filter((p) => p in allDeps);
    return { rateLimitPkgs, cachePkgs };
  } catch {
    /* skip: unreadable package.json */
    return { rateLimitPkgs: [], cachePkgs: [] };
  }
}

async function scanCodePatterns(projectPath: string): Promise<{
  hasRateLimitCode: boolean;
  hasCacheCode: boolean;
  filePatterns: Map<string, string[]>;
}> {
  const filePatterns = new Map<string, string[]>();
  let hasRateLimitCode = false;
  let hasCacheCode = false;

  const sourceFiles = await glob("**/*.{ts,tsx,js,jsx}", {
    cwd: projectPath,
    absolute: true,
    nodir: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**"],
  });

  for (const filePath of sourceFiles.slice(0, 500)) {
    try {
      const content = await readFile(filePath, "utf-8");
      const patterns: string[] = [];

      for (const pattern of RATE_LIMIT_CODE_PATTERNS) {
        if (pattern.test(content)) {
          hasRateLimitCode = true;
          patterns.push("rate-limit");
          break;
        }
      }

      for (const pattern of CACHE_CODE_PATTERNS) {
        if (pattern.test(content)) {
          hasCacheCode = true;
          patterns.push("cache");
          break;
        }
      }

      if (patterns.length > 0) filePatterns.set(filePath, patterns);
    } catch {
      /* skip: unreadable file */
    }
  }

  return { hasRateLimitCode, hasCacheCode, filePatterns };
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    /* skip: unreadable file */
    return null;
  }
}
