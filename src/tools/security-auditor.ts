// =============================================================================
// backend-max — Security Auditor
//
// Checks security posture: auth middleware coverage, CORS configuration,
// input validation, and common vulnerability patterns.
// =============================================================================

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "glob";
import type { Issue, IssueCategory, Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROUTE_PATTERNS = [
  "app/**/route.{ts,tsx,js,jsx}",
  "src/app/**/route.{ts,tsx,js,jsx}",
  "pages/api/**/*.{ts,tsx,js,jsx}",
  "src/pages/api/**/*.{ts,tsx,js,jsx}",
];

const IGNORE_DIRS = ["node_modules/**", ".next/**", "dist/**", "build/**", ".git/**"];

const MIDDLEWARE_FILES = [
  "middleware.ts",
  "middleware.js",
  "src/middleware.ts",
  "src/middleware.js",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit the security posture of a backend project.
 *
 * Checks:
 * 1. **Auth middleware coverage** -- are all routes protected?
 * 2. **CORS configuration** -- wildcard CORS in non-dev configs?
 * 3. **Input validation** -- raw body access without schema validation?
 * 4. **Known vulnerability patterns** -- SQL injection, exposed errors, etc.
 *
 * @param projectPath Absolute path to the project root.
 * @returns Issues found and a summary of the security posture.
 */
export async function auditSecurity(projectPath: string): Promise<{
  issues: Issue[];
  summary: {
    authCoverage: number;
    validationCoverage: number;
    corsConfigured: boolean;
  };
}> {
  const issues: Issue[] = [];
  let routesWithAuth = 0;
  let routesWithValidation = 0;
  let totalRoutes = 0;
  let corsConfigured = false;

  try {
    // Discover route files.
    const routeFiles = await discoverFiles(projectPath, ROUTE_PATTERNS);
    totalRoutes = routeFiles.length;

    // Parse middleware matchers.
    const middlewareMatchers = await parseMiddlewareMatchers(projectPath);
    const hasMiddleware = middlewareMatchers.length > 0;

    // Read all route files.
    const routeContents = await readFiles(routeFiles);

    // -----------------------------------------------------------------------
    // 1. Auth middleware coverage
    // -----------------------------------------------------------------------
    for (const [filePath, content] of routeContents) {
      const relPath = relative(projectPath, filePath);
      const routeUrl = filePathToUrl(relPath);

      const coveredByMiddleware =
        hasMiddleware && isRouteCoveredByMiddleware(routeUrl, middlewareMatchers);
      const hasInlineAuth = checkInlineAuth(content);

      if (coveredByMiddleware || hasInlineAuth) {
        routesWithAuth++;
      } else {
        // Only flag non-public routes (skip health checks, webhooks, etc.)
        if (!isLikelyPublicRoute(routeUrl)) {
          issues.push(
            makeIssue(
              `SEC-AUTH-${issues.length + 1}`,
              "security",
              "warning",
              `No auth protection: ${routeUrl}`,
              `Route ${routeUrl} (${relPath}) is not covered by auth middleware and contains no inline authentication checks. If this route requires authentication, add protection.`,
              filePath,
              null,
            ),
          );
        }
      }

      // -----------------------------------------------------------------------
      // 3. Input validation
      // -----------------------------------------------------------------------
      const hasBodyAccess = checkBodyAccess(content);
      const hasSchemaValidation = checkSchemaValidation(content);

      if (hasSchemaValidation) {
        routesWithValidation++;
      } else if (hasBodyAccess) {
        issues.push(
          makeIssue(
            `SEC-VAL-${issues.length + 1}`,
            "validation",
            "warning",
            `No input validation: ${routeUrl}`,
            `Route ${routeUrl} (${relPath}) accesses the request body without schema validation (Zod, Yup, Joi, etc.). Raw user input should always be validated.`,
            filePath,
            findLineNumber(content, /req(?:uest)?\.(?:body|json\(\))|await\s+request\.json\(\)/),
          ),
        );
      } else {
        // No body access -- still counts as "validated" (no input to validate)
        routesWithValidation++;
      }

      // -----------------------------------------------------------------------
      // 4. Known vulnerability patterns
      // -----------------------------------------------------------------------
      checkVulnerabilityPatterns(content, filePath, relPath, routeUrl, issues);
    }

    // -----------------------------------------------------------------------
    // 2. CORS configuration
    // -----------------------------------------------------------------------
    corsConfigured = await checkCorsConfiguration(projectPath, routeContents, issues);

    // -----------------------------------------------------------------------
    // 5. Rate limiting on auth endpoints
    // -----------------------------------------------------------------------
    await checkRateLimiting(projectPath, routeContents, issues);

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    const authCoverage = totalRoutes > 0 ? Math.round((routesWithAuth / totalRoutes) * 100) : 100;
    const validationCoverage =
      totalRoutes > 0 ? Math.round((routesWithValidation / totalRoutes) * 100) : 100;

    return {
      issues,
      summary: {
        authCoverage,
        validationCoverage,
        corsConfigured,
      },
    };
  } catch (error) {
    return {
      issues: [
        makeIssue(
          "SEC-INTERNAL-1",
          "security",
          "warning",
          "Security auditor encountered an internal error",
          `The security auditor failed: ${error instanceof Error ? error.message : String(error)}`,
          projectPath,
          null,
        ),
      ],
      summary: {
        authCoverage: 0,
        validationCoverage: 0,
        corsConfigured: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Middleware parsing
// ---------------------------------------------------------------------------

/**
 * Parse the Next.js middleware.ts file to extract route matcher patterns.
 */
async function parseMiddlewareMatchers(projectPath: string): Promise<string[]> {
  for (const mwFile of MIDDLEWARE_FILES) {
    const mwPath = join(projectPath, mwFile);
    let content: string;
    try {
      content = await readFile(mwPath, "utf-8");
    } catch {
      continue;
    }

    const matchers: string[] = [];

    // Match: export const config = { matcher: [...] }
    const matcherArrayRegex = /matcher\s*:\s*\[([^\]]*)\]/s;
    const arrayMatch = content.match(matcherArrayRegex);
    if (arrayMatch) {
      const entries = arrayMatch[1].matchAll(/['"]([^'"]+)['"]/g);
      for (const entry of entries) {
        matchers.push(entry[1]);
      }
    }

    // Match: export const config = { matcher: "..." }
    const matcherStringRegex = /matcher\s*:\s*['"]([^'"]+)['"]/;
    const stringMatch = content.match(matcherStringRegex);
    if (stringMatch && matchers.length === 0) {
      matchers.push(stringMatch[1]);
    }

    if (matchers.length > 0) return matchers;
  }

  return [];
}

/**
 * Check if a route URL is covered by any middleware matcher pattern.
 */
function isRouteCoveredByMiddleware(routeUrl: string, matchers: string[]): boolean {
  for (const matcher of matchers) {
    // Convert Next.js matcher to regex.
    const regexStr = matcher
      .replace(/\*/g, ".*")
      .replace(/\/:path\*/g, "(?:/.*)?")
      .replace(/\((?!\?)/g, "(?:")
      .replace(/\[([^\]]+)\]/g, "[^/]+");

    try {
      const regex = new RegExp(`^${regexStr}`);
      if (regex.test(routeUrl)) return true;
    } catch {
      // If regex is malformed, do a simple prefix check.
      const prefix = matcher.replace(/[*(:[\]]/g, "").replace(/\/+$/, "");
      if (routeUrl.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth detection
// ---------------------------------------------------------------------------

/**
 * Check if route file content contains inline authentication logic.
 */
function checkInlineAuth(content: string): boolean {
  const authPatterns = [
    /getServerSession/,
    /getSession/,
    /auth\(\)/,
    /currentUser/,
    /getUser/,
    /verifyToken/,
    /verifyAuth/,
    /authenticate/,
    /isAuthenticated/,
    /requireAuth/,
    /withAuth/,
    /clerkClient/,
    /getAuth\(/,
    /authorization/i,
    /bearer\s+token/i,
    /jwt\.verify/,
    /session\./,
    /token\./,
    /headers\(\).*(?:authorization|cookie)/i,
  ];

  return authPatterns.some((pattern) => pattern.test(content));
}

/**
 * Routes that are typically public and don't need auth.
 */
function isLikelyPublicRoute(routeUrl: string): boolean {
  const publicPatterns = [
    /\/api\/health/,
    /\/api\/ping/,
    /\/api\/status/,
    /\/api\/webhooks?\//,
    /\/api\/auth/,
    /\/api\/login/,
    /\/api\/register/,
    /\/api\/signup/,
    /\/api\/forgot-password/,
    /\/api\/reset-password/,
    /\/api\/verify/,
    /\/api\/public\//,
    /\/api\/og/,
    /\/api\/sitemap/,
    /\/api\/rss/,
    /\/api\/feed/,
    /\/api\/cron/,
  ];

  return publicPatterns.some((pattern) => pattern.test(routeUrl));
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function checkBodyAccess(content: string): boolean {
  const bodyPatterns = [
    /req\.body/,
    /request\.body/,
    /await\s+req\.json\(\)/,
    /await\s+request\.json\(\)/,
    /\.json\(\)\s*(?:as|;)/,
    /req\.query/,
    /request\.nextUrl\.searchParams/,
  ];
  return bodyPatterns.some((pattern) => pattern.test(content));
}

function checkSchemaValidation(content: string): boolean {
  const validationPatterns = [
    /\.parse\(/, // Zod
    /\.safeParse\(/, // Zod
    /\.validate\(/, // Yup / Joi
    /\.validateAsync\(/, // Joi
    /createValidator/,
    /withValidation/,
    /zodResolver/,
    /z\.object/, // Zod schema definition
    /yup\.object/, // Yup schema definition
    /Joi\.object/, // Joi schema definition
    /ajv/i, // AJV validator
    /class-validator/,
    /typebox/i, // TypeBox
  ];
  return validationPatterns.some((pattern) => pattern.test(content));
}

// ---------------------------------------------------------------------------
// Vulnerability patterns
// ---------------------------------------------------------------------------

function checkVulnerabilityPatterns(
  content: string,
  filePath: string,
  relPath: string,
  routeUrl: string,
  issues: Issue[],
): void {
  // SQL string concatenation (potential injection).
  const sqlConcatPatterns = [
    /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE).*\$\{/i,
    /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE).*\+\s*(?:req|request|params|query)/i,
    /`(?:SELECT|INSERT|UPDATE|DELETE).*\$\{/i,
  ];

  for (const pattern of sqlConcatPatterns) {
    if (pattern.test(content)) {
      issues.push(
        makeIssue(
          `SEC-SQLI-${issues.length + 1}`,
          "security",
          "critical",
          `Potential SQL injection: ${routeUrl}`,
          `Route ${routeUrl} (${relPath}) appears to use string concatenation in SQL queries. Use parameterised queries or an ORM to prevent SQL injection.`,
          filePath,
          findLineNumber(content, pattern),
        ),
      );
      break; // one issue per file
    }
  }

  // Exposed error details in production.
  const errorDetailPatterns = [/error\.(message|stack)/, /err\.(message|stack)/];

  for (const pattern of errorDetailPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      // Check if there's a NODE_ENV guard around it.
      const hasEnvGuard =
        content.includes("NODE_ENV") &&
        (content.includes("development") || content.includes("production"));

      if (!hasEnvGuard) {
        issues.push(
          makeIssue(
            `SEC-ERR-${issues.length + 1}`,
            "security",
            "warning",
            `Exposed error details: ${routeUrl}`,
            `Route ${routeUrl} (${relPath}) may expose internal error details (${matches[0]}) in responses without checking NODE_ENV. Sanitise error messages in production.`,
            filePath,
            findLineNumber(content, pattern),
          ),
        );
        break; // one issue per file
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CORS check
// ---------------------------------------------------------------------------

async function checkCorsConfiguration(
  projectPath: string,
  routeContents: Map<string, string>,
  issues: Issue[],
): Promise<boolean> {
  let corsFound = false;

  // Check next.config for headers.
  const nextConfigFiles = ["next.config.js", "next.config.mjs", "next.config.ts"];
  for (const configFile of nextConfigFiles) {
    try {
      const content = await readFile(join(projectPath, configFile), "utf-8");
      if (content.includes("Access-Control-Allow-Origin")) {
        corsFound = true;
        if (/Access-Control-Allow-Origin.*\*/.test(content)) {
          // Check if it's gated by environment.
          if (!content.includes("NODE_ENV") && !content.includes("development")) {
            issues.push(
              makeIssue(
                `SEC-CORS-${issues.length + 1}`,
                "security",
                "warning",
                "Wildcard CORS in config",
                `${configFile} sets Access-Control-Allow-Origin to "*" without a development-only guard. Restrict CORS to specific origins in production.`,
                join(projectPath, configFile),
                null,
              ),
            );
          }
        }
      }
    } catch {
      // file doesn't exist
    }
  }

  // Check route files for inline CORS headers.
  for (const [filePath, content] of routeContents) {
    if (content.includes("Access-Control-Allow-Origin")) {
      corsFound = true;
      if (/Access-Control-Allow-Origin.*\*/.test(content)) {
        const relPath = relative(projectPath, filePath);
        if (!content.includes("NODE_ENV") && !content.includes("development")) {
          issues.push(
            makeIssue(
              `SEC-CORS-${issues.length + 1}`,
              "security",
              "warning",
              `Wildcard CORS in ${relPath}`,
              `${relPath} sets Access-Control-Allow-Origin to "*" without a development-only guard. Restrict CORS in production.`,
              filePath,
              findLineNumber(content, /Access-Control-Allow-Origin/),
            ),
          );
        }
      }
    }
  }

  return corsFound;
}

// ---------------------------------------------------------------------------
// Rate limiting check
// ---------------------------------------------------------------------------

async function checkRateLimiting(
  _projectPath: string,
  routeContents: Map<string, string>,
  issues: Issue[],
): Promise<void> {
  const authRoutePatterns = [
    /\/api\/auth/,
    /\/api\/login/,
    /\/api\/register/,
    /\/api\/signup/,
    /\/api\/forgot-password/,
    /\/api\/reset-password/,
    /\/api\/token/,
  ];

  const rateLimitPatterns = [
    /rateLimit/i,
    /rate-limit/i,
    /rateLimiter/i,
    /upstash.*ratelimit/i,
    /limiter/i,
    /throttle/i,
  ];

  for (const [filePath, content] of routeContents) {
    const relPath = relative(filePath, filePath);
    const routeUrl = filePathToUrl(relPath);

    const isAuthRoute = authRoutePatterns.some((p) => p.test(filePath));
    if (!isAuthRoute) continue;

    const hasRateLimit = rateLimitPatterns.some((p) => p.test(content));
    if (!hasRateLimit) {
      issues.push(
        makeIssue(
          `SEC-RATE-${issues.length + 1}`,
          "security",
          "warning",
          `No rate limiting on auth endpoint: ${routeUrl}`,
          `Auth endpoint ${filePath} does not appear to implement rate limiting. Auth endpoints are prime targets for brute-force attacks.`,
          filePath,
          null,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// File & path helpers
// ---------------------------------------------------------------------------

async function discoverFiles(projectPath: string, patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: IGNORE_DIRS,
    });
    files.push(...matches);
  }
  // Deduplicate.
  return [...new Set(files)];
}

async function readFiles(filePaths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const fp of filePaths) {
    try {
      const content = await readFile(fp, "utf-8");
      map.set(fp, content);
    } catch {
      // skip unreadable
    }
  }
  return map;
}

/**
 * Convert a relative file path to a URL pattern.
 * e.g. "app/api/users/[id]/route.ts" -> "/api/users/[id]"
 */
function filePathToUrl(relPath: string): string {
  return (
    "/" +
    relPath
      .replace(/^(?:src\/)?(?:app|pages)\//, "")
      .replace(/\/route\.\w+$/, "")
      .replace(/\.\w+$/, "")
  );
}

function findLineNumber(content: string, pattern: RegExp): number | null {
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;
  const lines = content.slice(0, match.index).split("\n");
  return lines.length;
}

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
