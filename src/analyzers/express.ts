// =============================================================================
// backend-max — Express.js route analyzer
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import type { Issue, MethodInfo, RouteInfo } from "../types.js";
import type { FrameworkAnalyzer, FrameworkCheck } from "./framework-interface.js";
import {
  createProject,
  detectAuthPatterns,
  detectDatabaseCalls,
  detectErrorHandling,
  detectValidation,
} from "./typescript.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Express HTTP methods we scan for. */
const EXPRESS_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "all",
] as const;

/** Patterns that indicate Express route definitions. */
const ROUTE_CALL_REGEX = new RegExp(`(?:app|router)\\.(${EXPRESS_METHODS.join("|")})\\s*\\(`, "g");

/** Pattern to detect express.Router() usage. */
const ROUTER_DECL_REGEX = /express\.Router\s*\(\s*\)/;

/** Pattern to detect router mounting: app.use('/prefix', routerVar). */
const MOUNT_REGEX = /app\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)/g;

// ---------------------------------------------------------------------------
// Express Analyzer
// ---------------------------------------------------------------------------

/**
 * Creates an Express.js framework analyzer implementing FrameworkAnalyzer.
 */
export function createExpressAnalyzer(): FrameworkAnalyzer {
  return {
    name: "express",
    detect,
    scanRoutes: scanExpressRoutes,
    getFrameworkChecks,
  };
}

/**
 * Detect if Express is used in the project by checking package.json.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns True if "express" is listed as a dependency.
 */
async function detect(projectPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    return "express" in deps || "express" in devDeps;
  } catch {
    /* skip: unreadable/unparseable package.json */
    return false;
  }
}

/**
 * Scan all Express routes in the project.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns Array of RouteInfo objects.
 */
async function scanExpressRoutes(projectPath: string): Promise<RouteInfo[]> {
  // Find all .ts/.js files (excluding node_modules, dist, etc.)
  const sourceFiles = await glob("**/*.{ts,js}", {
    cwd: projectPath,
    absolute: true,
    nodir: true,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
    ],
  });

  // First pass: find files that contain Express route patterns
  const routeFiles: Array<{ filePath: string; content: string }> = [];

  for (const filePath of sourceFiles) {
    try {
      const content = await readFile(filePath, "utf-8");
      ROUTE_CALL_REGEX.lastIndex = 0;
      if (ROUTE_CALL_REGEX.test(content) || ROUTER_DECL_REGEX.test(content)) {
        routeFiles.push({ filePath, content });
      }
      ROUTE_CALL_REGEX.lastIndex = 0;
    } catch {
      /* skip: unreadable file */
    }
  }

  if (routeFiles.length === 0) {
    return [];
  }

  // Build router mount map from app entry files
  const mountMap = await buildMountMap(routeFiles);

  // Second pass: parse with ts-morph and extract route info
  const project = createProject(projectPath);
  const allRoutes: RouteInfo[] = [];

  for (const { filePath, content } of routeFiles) {
    try {
      const routes = analyzeExpressFile(filePath, content, project, mountMap);
      allRoutes.push(...routes);
    } catch {
      /* skip: unreadable/unparseable file */
    }
  }

  // Sort for deterministic output
  allRoutes.sort((a, b) => a.url.localeCompare(b.url));
  return allRoutes;
}

// ---------------------------------------------------------------------------
// Mount map
// ---------------------------------------------------------------------------

/**
 * Builds a mapping from router variable names to their mount prefixes.
 * Scans for `app.use('/prefix', routerVar)` patterns.
 */
async function buildMountMap(
  routeFiles: Array<{ filePath: string; content: string }>,
): Promise<Map<string, string>> {
  const mountMap = new Map<string, string>();

  for (const { content } of routeFiles) {
    let match: RegExpExecArray | null;
    MOUNT_REGEX.lastIndex = 0;
    while ((match = MOUNT_REGEX.exec(content)) !== null) {
      const prefix = match[1];
      const varName = match[2];
      mountMap.set(varName, prefix);
    }
  }

  return mountMap;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

/**
 * Analyzes a single Express file for route definitions.
 *
 * @param filePath  Absolute path to the file.
 * @param content   Raw file content.
 * @param project   ts-morph Project instance.
 * @param mountMap  Router variable -> mount prefix mapping.
 * @returns Array of RouteInfo objects found in this file.
 */
function analyzeExpressFile(
  filePath: string,
  _content: string,
  project: Project,
  mountMap: Map<string, string>,
): RouteInfo[] {
  let sourceFile: SourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(filePath);
  } catch {
    /* skip: unreadable/unparseable file */
    return [];
  }

  // Determine if this file uses a router variable
  const routerPrefix = detectRouterPrefix(sourceFile, mountMap);

  // Find all route method calls
  const routeMap = new Map<string, MethodInfo[]>();

  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const expr = call.getExpression();

    // Match app.get(...) or router.get(...) patterns
    if (!Node.isPropertyAccessExpression(expr)) continue;

    const methodName = expr.getName().toLowerCase();
    if (!(EXPRESS_METHODS as readonly string[]).includes(methodName)) continue;

    const objName = expr.getExpression().getText();
    if (objName !== "app" && objName !== "router" && !mountMap.has(objName)) continue;

    // Extract the URL pattern (first argument)
    const args = call.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0];
    const urlPattern = firstArg.getText().replace(/^['"`]|['"`]$/g, "");

    // Skip non-string first arguments (middleware-only calls)
    if (urlPattern.startsWith("(") || urlPattern.startsWith("{")) continue;

    // Apply mount prefix
    const prefix = objName === "router" ? routerPrefix : (mountMap.get(objName) ?? "");
    const fullUrl = normalizePath(prefix + urlPattern);

    const httpMethod = methodName === "all" ? "ALL" : methodName.toUpperCase();

    // Analyze the handler (last argument, usually a function)
    const handler = args[args.length - 1];
    const methodInfo = buildExpressMethodInfo(httpMethod, handler, call);

    if (!routeMap.has(fullUrl)) {
      routeMap.set(fullUrl, []);
    }
    routeMap.get(fullUrl)?.push(methodInfo);
  }

  // Convert to RouteInfo array
  const routes: RouteInfo[] = [];
  for (const [url, methods] of routeMap) {
    routes.push({
      filePath,
      url,
      methods,
      dynamicParams: extractExpressParams(url),
    });
  }

  return routes;
}

/**
 * Detects the router mount prefix for a file that declares express.Router().
 */
function detectRouterPrefix(sourceFile: SourceFile, mountMap: Map<string, string>): string {
  // Look for `const <name> = express.Router()` and check mount map
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const initText = init.getText();
      if (ROUTER_DECL_REGEX.test(initText)) {
        const varName = decl.getName();
        if (mountMap.has(varName)) {
          return mountMap.get(varName)!;
        }
      }
    }
  }

  // If the file itself exports a router via module.exports, check mount map values
  // that reference common filename patterns
  return "";
}

/**
 * Builds MethodInfo from an Express route handler.
 */
function buildExpressMethodInfo(method: string, handlerNode: Node, callNode: Node): MethodInfo {
  return {
    method,
    hasValidation: detectValidation(handlerNode),
    hasErrorHandling: detectErrorHandling(handlerNode),
    hasDatabaseCalls: detectDatabaseCalls(handlerNode).length > 0,
    hasAuth: detectAuthPatterns(handlerNode),
    returnType: null,
    databaseCalls: detectDatabaseCalls(handlerNode),
    lineNumber: callNode.getStartLineNumber(),
  };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Normalizes a URL path (removes double slashes, ensures leading slash).
 */
function normalizePath(urlPath: string): string {
  let normalized = urlPath.replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Extracts Express-style dynamic parameters from a URL pattern.
 * E.g. "/users/:id/posts/:postId" -> ["id", "postId"]
 */
function extractExpressParams(url: string): string[] {
  const params: string[] = [];
  const regex = /:(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(url)) !== null) {
    params.push(match[1]);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Framework-specific checks
// ---------------------------------------------------------------------------

/**
 * Returns Express-specific diagnostic checks.
 */
function getFrameworkChecks(): FrameworkCheck[] {
  return [
    {
      id: "express-missing-error-middleware",
      name: "Missing error-handling middleware",
      description:
        "Express apps should have a centralized error-handling middleware with the (err, req, res, next) signature.",
      check: checkMissingErrorMiddleware,
    },
    {
      id: "express-missing-404-handler",
      name: "Missing 404 handler",
      description: "Express apps should have a catch-all handler for unmatched routes.",
      check: checkMissing404Handler,
    },
    {
      id: "express-listen-in-route-file",
      name: "app.listen() in route file",
      description:
        "app.listen() should only appear in the main server entry file, not in route modules.",
      check: checkListenInRouteFile,
    },
    {
      id: "express-missing-security-middleware",
      name: "Missing security middleware",
      description:
        "Express apps should use helmet and/or cors middleware for basic security hardening.",
      check: checkMissingSecurityMiddleware,
    },
    {
      id: "express-missing-body-parser",
      name: "Missing body parser middleware",
      description:
        "Express apps handling POST/PUT requests should use express.json() or express.urlencoded() middleware.",
      check: checkMissingBodyParser,
    },
  ];
}

/**
 * Checks for missing error-handling middleware (err, req, res, next).
 */
async function checkMissingErrorMiddleware(
  projectPath: string,
  _routes: RouteInfo[],
): Promise<Issue[]> {
  const entryFiles = await findExpressEntryFiles(projectPath);
  const timestamp = new Date().toISOString();

  for (const { filePath, content } of entryFiles) {
    // Error middleware has 4 params: (err, req, res, next)
    if (
      /app\.use\s*\(\s*(?:function\s*\()?\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+/.test(content) ||
      /app\.use\s*\(\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/.test(content)
    ) {
      return [];
    }
  }

  if (entryFiles.length === 0) return [];

  return [
    {
      id: "",
      category: "error-handling",
      severity: "critical",
      title: "Missing Express error-handling middleware",
      description:
        "No centralized error middleware found. Add app.use((err, req, res, next) => { ... }) to handle uncaught errors gracefully.",
      file: entryFiles[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

/**
 * Checks for missing 404 catch-all handler.
 */
async function checkMissing404Handler(projectPath: string, _routes: RouteInfo[]): Promise<Issue[]> {
  const entryFiles = await findExpressEntryFiles(projectPath);
  const timestamp = new Date().toISOString();

  for (const { content } of entryFiles) {
    // Common 404 patterns
    if (
      /404/.test(content) &&
      (/app\.use\s*\(\s*(?:function|\()/.test(content) || /\.status\s*\(\s*404\s*\)/.test(content))
    ) {
      return [];
    }
  }

  if (entryFiles.length === 0) return [];

  return [
    {
      id: "",
      category: "error-handling",
      severity: "warning",
      title: "Missing 404 handler",
      description:
        "No catch-all 404 handler found. Unmatched routes will receive Express's default HTML error page.",
      file: entryFiles[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

/**
 * Checks for app.listen() appearing in route/module files instead of the entry point.
 */
async function checkListenInRouteFile(_projectPath: string, routes: RouteInfo[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();
  const seen = new Set<string>();

  for (const route of routes) {
    if (seen.has(route.filePath)) continue;
    seen.add(route.filePath);

    try {
      const content = await readFile(route.filePath, "utf-8");
      if (/app\.listen\s*\(/.test(content) || /server\.listen\s*\(/.test(content)) {
        // Check if this file also defines routes — that's the anti-pattern
        ROUTE_CALL_REGEX.lastIndex = 0;
        if (ROUTE_CALL_REGEX.test(content)) {
          ROUTE_CALL_REGEX.lastIndex = 0;
          issues.push({
            id: "",
            category: "error-handling",
            severity: "info",
            title: "app.listen() found in route file",
            description:
              "Server startup (app.listen) and route definitions are in the same file. Consider separating them for testability.",
            file: route.filePath,
            line: null,
            status: "open",
            firstSeen: timestamp,
            fixedAt: null,
          });
        }
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  return issues;
}

/**
 * Checks for missing helmet/cors middleware.
 */
async function checkMissingSecurityMiddleware(
  projectPath: string,
  _routes: RouteInfo[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();
  const entryFiles = await findExpressEntryFiles(projectPath);

  let hasHelmet = false;
  let hasCors = false;

  // Also check package.json for dependencies
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    hasHelmet = "helmet" in deps;
    hasCors = "cors" in deps;
  } catch {
    /* skip: unreadable/unparseable package.json */
  }

  // Also scan entry files for usage
  for (const { content } of entryFiles) {
    if (/helmet\s*\(/.test(content)) hasHelmet = true;
    if (/cors\s*\(/.test(content)) hasCors = true;
  }

  if (!hasHelmet) {
    issues.push({
      id: "",
      category: "security",
      severity: "warning",
      title: "Missing helmet middleware",
      description:
        "helmet sets various HTTP security headers. Install and use it: app.use(helmet())",
      file: entryFiles[0]?.filePath ?? join(projectPath, "package.json"),
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  if (!hasCors) {
    issues.push({
      id: "",
      category: "security",
      severity: "warning",
      title: "Missing cors middleware",
      description:
        "No CORS configuration found. If this API serves browser clients, add cors middleware with explicit origin config.",
      file: entryFiles[0]?.filePath ?? join(projectPath, "package.json"),
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  return issues;
}

/**
 * Checks for missing body parser middleware.
 */
async function checkMissingBodyParser(projectPath: string, routes: RouteInfo[]): Promise<Issue[]> {
  const timestamp = new Date().toISOString();

  // Only relevant if there are POST/PUT/PATCH routes
  const hasMutationRoutes = routes.some((r) =>
    r.methods.some((m) => ["POST", "PUT", "PATCH", "ALL"].includes(m.method)),
  );
  if (!hasMutationRoutes) return [];

  const entryFiles = await findExpressEntryFiles(projectPath);

  for (const { content } of entryFiles) {
    if (
      /express\.json\s*\(/.test(content) ||
      /express\.urlencoded\s*\(/.test(content) ||
      /bodyParser/.test(content) ||
      /body-parser/.test(content)
    ) {
      return [];
    }
  }

  if (entryFiles.length === 0) return [];

  return [
    {
      id: "",
      category: "validation",
      severity: "info",
      title: "Missing body parser middleware",
      description:
        "No express.json() or express.urlencoded() middleware found, but mutation routes exist. Request bodies may not be parsed.",
      file: entryFiles[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds likely Express app entry files in the project.
 */
async function findExpressEntryFiles(
  projectPath: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const candidates = await glob(
    "{app,server,index,main,src/app,src/server,src/index,src/main}.{ts,js}",
    {
      cwd: projectPath,
      absolute: true,
      nodir: true,
    },
  );

  const results: Array<{ filePath: string; content: string }> = [];

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (/express/.test(content)) {
        results.push({ filePath, content });
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  return results;
}
