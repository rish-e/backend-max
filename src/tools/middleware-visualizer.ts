// =============================================================================
// backend-max — Middleware chain visualization
// =============================================================================

import { readFile } from "node:fs/promises";
import { glob } from "glob";
import type { Issue, RouteInfo } from "../types.js";
import { getTimestamp } from "../utils/helpers.js";
import { scanRoutes } from "./route-scanner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single middleware in the chain. */
export interface MiddlewareEntry {
  /** Name or description of the middleware. */
  name: string;
  /** Type of middleware. */
  type: "auth" | "validation" | "rate-limit" | "cors" | "logging" | "error" | "parser" | "custom";
  /** File where it's defined or imported. */
  file: string;
  /** Line number, if determinable. */
  line: number | null;
  /** Route pattern it applies to ("*" for global). */
  appliesTo: string;
}

/** The full middleware chain for a route. */
export interface MiddlewareChain {
  /** The route URL pattern. */
  route: string;
  /** HTTP method. */
  method: string;
  /** Ordered list of middleware that runs before the handler. */
  middleware: MiddlewareEntry[];
  /** The route handler file. */
  handlerFile: string;
}

/** Result of middleware visualization. */
export interface MiddlewareVisualizationResult {
  /** Issues found during analysis. */
  issues: Issue[];
  /** All global middleware detected. */
  globalMiddleware: MiddlewareEntry[];
  /** Per-route middleware chains. */
  chains: MiddlewareChain[];
  /** Human-readable summary. */
  summary: string;
  /** Markdown-formatted visualization. */
  visualization: string;
}

// ---------------------------------------------------------------------------
// Known middleware patterns
// ---------------------------------------------------------------------------

const MIDDLEWARE_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  type: MiddlewareEntry["type"];
}> = [
  // Auth
  {
    pattern:
      /auth\s*\(|authenticate|passport\.authenticate|withAuth|requireAuth|clerkMiddleware|authMiddleware/i,
    name: "auth",
    type: "auth",
  },
  {
    pattern: /getServerSession|getSession|verifyToken|verifyJwt|jwt\s*\(/i,
    name: "session-auth",
    type: "auth",
  },

  // Validation
  {
    pattern: /zValidator|validate|validateRequest|validateBody|celebrate|joi\.validate/i,
    name: "validation",
    type: "validation",
  },

  // Rate limiting
  { pattern: /rateLimit|rateLimiter|throttle|slowDown/i, name: "rate-limit", type: "rate-limit" },

  // CORS
  { pattern: /cors\s*\(/i, name: "cors", type: "cors" },

  // Logging
  { pattern: /morgan\s*\(|pino\s*\(|winston|logger|logging/i, name: "logging", type: "logging" },

  // Error handling
  { pattern: /errorHandler|onError|setErrorHandler/i, name: "error-handler", type: "error" },

  // Parsers
  {
    pattern: /express\.json|express\.urlencoded|bodyParser|cookieParser|multer/i,
    name: "body-parser",
    type: "parser",
  },
  { pattern: /helmet\s*\(/i, name: "helmet", type: "custom" },
  { pattern: /compression\s*\(/i, name: "compression", type: "custom" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyzes and visualizes the middleware chain for all routes.
 */
export async function visualizeMiddleware(
  projectPath: string,
): Promise<MiddlewareVisualizationResult> {
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
      globalMiddleware: [],
      chains: [],
      summary: "Could not scan routes for middleware analysis.",
      visualization: "",
    };
  }

  // 2. Find global middleware (app.use() / middleware.ts)
  const globalMiddleware = await detectGlobalMiddleware(projectPath);

  // 3. Find Next.js middleware (middleware.ts)
  const nextjsMiddleware = await detectNextjsMiddleware(projectPath);
  globalMiddleware.push(...nextjsMiddleware);

  // 4. Build middleware chains for each route
  const chains: MiddlewareChain[] = [];

  for (const route of routes) {
    for (const method of route.methods) {
      const chain: MiddlewareEntry[] = [];

      // Add global middleware that applies to this route
      for (const mw of globalMiddleware) {
        if (mw.appliesTo === "*" || route.url.startsWith(mw.appliesTo)) {
          chain.push(mw);
        }
      }

      // Detect inline middleware from route file
      const inlineMiddleware = await detectInlineMiddleware(route.filePath, route.url);
      chain.push(...inlineMiddleware);

      chains.push({
        route: route.url,
        method: method.method,
        middleware: chain,
        handlerFile: route.filePath,
      });
    }
  }

  // 5. Detect ordering issues
  for (const chain of chains) {
    const types = chain.middleware.map((m) => m.type);

    // Auth should come before handler logic, after CORS
    const corsIdx = types.indexOf("cors");
    const authIdx = types.indexOf("auth");
    const _validationIdx = types.indexOf("validation");

    if (corsIdx !== -1 && authIdx !== -1 && corsIdx > authIdx) {
      issues.push({
        id: "",
        category: "security",
        severity: "warning",
        title: `Middleware ordering issue: ${chain.method} ${chain.route}`,
        description:
          "CORS middleware runs after auth middleware. CORS should be first to handle preflight requests before auth checks.",
        file: chain.handlerFile,
        line: null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }

    // Check for auth endpoints without rate limiting
    if (/login|signin|register|signup|password|token|otp/i.test(chain.route)) {
      const hasRateLimit = types.includes("rate-limit");
      if (!hasRateLimit) {
        issues.push({
          id: "",
          category: "security",
          severity: "warning",
          title: `Auth endpoint without rate limiting middleware: ${chain.route}`,
          description:
            "This authentication endpoint has no rate limiting middleware in its chain. Add rate limiting to prevent brute-force attacks.",
          file: chain.handlerFile,
          line: null,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }
  }

  // 6. Check for routes with NO middleware at all
  const unprotectedMutations = chains.filter(
    (c) => ["POST", "PUT", "PATCH", "DELETE"].includes(c.method) && c.middleware.length === 0,
  );

  if (unprotectedMutations.length > 0) {
    issues.push({
      id: "",
      category: "security",
      severity: "warning",
      title: `${unprotectedMutations.length} mutation endpoint(s) with no middleware`,
      description:
        `These endpoints have no middleware chain: ${unprotectedMutations
          .slice(0, 5)
          .map((c) => `${c.method} ${c.route}`)
          .join(", ")}. ` + `Consider adding auth, validation, or rate limiting middleware.`,
      file: unprotectedMutations[0].handlerFile,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  // 7. Build visualization
  const visualization = buildVisualization(globalMiddleware, chains);

  const summary = [
    `${globalMiddleware.length} global middleware detected.`,
    `${chains.length} route chains analyzed.`,
    `${issues.length} ordering/coverage issue(s).`,
  ].join(" ");

  return {
    issues,
    globalMiddleware,
    chains,
    summary,
    visualization,
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

async function detectGlobalMiddleware(projectPath: string): Promise<MiddlewareEntry[]> {
  const entries: MiddlewareEntry[] = [];

  // Look for app.use() patterns in entry files
  const candidates = await glob(
    "{app,server,index,main,src/app,src/server,src/index,src/main}.{ts,js}",
    { cwd: projectPath, absolute: true, nodir: true },
  );

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      // Find app.use() calls
      const useRegex = /(?:app|server|fastify|hono)\.use\s*\(/g;
      let match: RegExpExecArray | null;
      useRegex.lastIndex = 0;

      while ((match = useRegex.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split("\n").length;
        const _lineContent = lines[lineNum - 1] ?? "";

        // Determine what middleware this is
        const surrounding = content.slice(match.index, Math.min(match.index + 200, content.length));

        // Check for route-specific middleware: app.use('/api', ...)
        const prefixMatch = surrounding.match(/\.use\s*\(\s*['"`]([^'"`]+)['"`]/);
        const appliesTo = prefixMatch ? prefixMatch[1] : "*";

        for (const mp of MIDDLEWARE_PATTERNS) {
          if (mp.pattern.test(surrounding)) {
            entries.push({
              name: mp.name,
              type: mp.type,
              file: filePath,
              line: lineNum,
              appliesTo,
            });
            break;
          }
        }
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  return entries;
}

async function detectNextjsMiddleware(projectPath: string): Promise<MiddlewareEntry[]> {
  const entries: MiddlewareEntry[] = [];

  // Check for Next.js middleware.ts
  const middlewareFiles = await glob("{middleware,src/middleware}.{ts,js}", {
    cwd: projectPath,
    absolute: true,
    nodir: true,
  });

  for (const filePath of middlewareFiles) {
    try {
      const content = await readFile(filePath, "utf-8");

      // Check what the middleware does
      for (const mp of MIDDLEWARE_PATTERNS) {
        if (mp.pattern.test(content)) {
          entries.push({
            name: `nextjs-middleware:${mp.name}`,
            type: mp.type,
            file: filePath,
            line: 1,
            appliesTo: "*",
          });
        }
      }

      // Check for matcher config
      const matcherMatch = content.match(/matcher\s*:\s*\[([^\]]+)\]/);
      if (matcherMatch) {
        // If there's a matcher, the middleware only applies to matched routes
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          lastEntry.appliesTo = `matcher: ${matcherMatch[1].trim()}`;
        }
      }

      // If no specific patterns matched, still record it as custom middleware
      if (entries.length === 0) {
        entries.push({
          name: "nextjs-middleware",
          type: "custom",
          file: filePath,
          line: 1,
          appliesTo: "*",
        });
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  return entries;
}

async function detectInlineMiddleware(
  filePath: string,
  routeUrl: string,
): Promise<MiddlewareEntry[]> {
  const entries: MiddlewareEntry[] = [];

  try {
    const content = await readFile(filePath, "utf-8");

    for (const mp of MIDDLEWARE_PATTERNS) {
      if (mp.pattern.test(content)) {
        entries.push({
          name: mp.name,
          type: mp.type,
          file: filePath,
          line: null,
          appliesTo: routeUrl,
        });
      }
    }
  } catch {
    /* skip: unreadable file */
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Visualization
// ---------------------------------------------------------------------------

function buildVisualization(
  globalMiddleware: MiddlewareEntry[],
  chains: MiddlewareChain[],
): string {
  const lines: string[] = [];

  lines.push("# Middleware Chain Visualization");
  lines.push("");

  // Global middleware
  if (globalMiddleware.length > 0) {
    lines.push("## Global Middleware");
    lines.push("");
    lines.push("| # | Name | Type | Applies To |");
    lines.push("|---|------|------|------------|");
    for (let i = 0; i < globalMiddleware.length; i++) {
      const mw = globalMiddleware[i];
      lines.push(`| ${i + 1} | ${mw.name} | ${mw.type} | ${mw.appliesTo} |`);
    }
    lines.push("");
  }

  // Group chains by route for cleaner output
  const routeChains = new Map<string, MiddlewareChain[]>();
  for (const chain of chains) {
    const key = `${chain.method} ${chain.route}`;
    if (!routeChains.has(key)) routeChains.set(key, []);
    routeChains.get(key)?.push(chain);
  }

  lines.push("## Route Middleware Chains");
  lines.push("");

  for (const [routeKey, routeChainList] of routeChains) {
    const chain = routeChainList[0];
    if (chain.middleware.length === 0) {
      lines.push(`### ${routeKey}`);
      lines.push("`(no middleware)` -> **handler**");
      lines.push("");
    } else {
      lines.push(`### ${routeKey}`);
      const middlewareFlow = chain.middleware.map((mw) => `\`${mw.name}\``).join(" -> ");
      lines.push(`${middlewareFlow} -> **handler**`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
