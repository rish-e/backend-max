// =============================================================================
// backend-max — Hono route analyzer
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

const HONO_METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "all"] as const;

const ROUTE_CALL_REGEX = new RegExp(
  `(?:app|hono|router|api)\\.(${HONO_METHODS.join("|")})\\s*\\(`,
  "g",
);

/** Pattern for Hono middleware .use() calls. */
const _MIDDLEWARE_REGEX = /(?:app|hono|router)\.use\s*\(/g;

/** Pattern for Hono validator middleware. */
const HONO_VALIDATOR_REGEX = /zValidator|validator\s*\(/;

// ---------------------------------------------------------------------------
// Hono Analyzer
// ---------------------------------------------------------------------------

export function createHonoAnalyzer(): FrameworkAnalyzer {
  return {
    name: "hono",
    detect,
    scanRoutes: scanHonoRoutes,
    getFrameworkChecks,
  };
}

async function detect(projectPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object") return false;
    const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
    const devDeps =
      pkg.devDependencies && typeof pkg.devDependencies === "object" ? pkg.devDependencies : {};
    return "hono" in deps || "hono" in devDeps;
  } catch {
    /* skip: unreadable/unparseable package.json */
    return false;
  }
}

async function scanHonoRoutes(projectPath: string): Promise<RouteInfo[]> {
  const sourceFiles = await glob("**/*.{ts,tsx,js,jsx}", {
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

  const routeFiles: Array<{ filePath: string; content: string }> = [];

  for (const filePath of sourceFiles) {
    try {
      const content = await readFile(filePath, "utf-8");
      ROUTE_CALL_REGEX.lastIndex = 0;
      if (ROUTE_CALL_REGEX.test(content) && /hono|Hono/i.test(content)) {
        routeFiles.push({ filePath, content });
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  if (routeFiles.length === 0) return [];

  const project = createProject(projectPath);
  const allRoutes: RouteInfo[] = [];

  for (const { filePath, content } of routeFiles) {
    try {
      const routes = analyzeHonoFile(filePath, content, project);
      allRoutes.push(...routes);
    } catch {
      /* skip: unparseable file */
    }
  }

  allRoutes.sort((a, b) => a.url.localeCompare(b.url));
  return allRoutes;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

function analyzeHonoFile(filePath: string, content: string, project: Project): RouteInfo[] {
  let sourceFile: SourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(filePath);
  } catch {
    /* skip: unparseable file */
    return [];
  }

  // Detect basePath from Hono constructor: new Hono().basePath('/api')
  const basePath = extractBasePath(content);
  const routeMap = new Map<string, MethodInfo[]>();

  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;

    const methodName = expr.getName().toLowerCase();
    if (!(HONO_METHODS as readonly string[]).includes(methodName)) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0];
    const urlPattern = firstArg.getText().replace(/^['"`]|['"`]$/g, "");
    if (urlPattern.startsWith("(") || urlPattern.startsWith("{")) continue;

    // Apply basePath
    const fullUrl = normalizePath(basePath + urlPattern);
    const httpMethod = methodName === "all" ? "ALL" : methodName.toUpperCase();

    // Handler is the last argument; middleware handlers may be in between
    const handler = args[args.length - 1];
    const dbCalls = detectDatabaseCalls(handler);

    // Check for Hono validator in middleware args
    const middlewareArgs = args.slice(1, -1);
    const hasHonoValidator =
      middlewareArgs.some((arg) => HONO_VALIDATOR_REGEX.test(arg.getText())) ||
      HONO_VALIDATOR_REGEX.test(handler.getText());

    const methodInfo: MethodInfo = {
      method: httpMethod,
      hasValidation: hasHonoValidator || detectValidation(handler),
      hasErrorHandling: detectErrorHandling(handler),
      hasDatabaseCalls: dbCalls.length > 0,
      hasAuth: detectAuthPatterns(handler) || middlewareArgs.some((a) => detectAuthPatterns(a)),
      returnType: null,
      databaseCalls: dbCalls,
      lineNumber: call.getStartLineNumber(),
    };

    if (!routeMap.has(fullUrl)) {
      routeMap.set(fullUrl, []);
    }
    routeMap.get(fullUrl)?.push(methodInfo);
  }

  const routes: RouteInfo[] = [];
  for (const [url, methods] of routeMap) {
    routes.push({
      filePath,
      url,
      methods,
      dynamicParams: extractHonoParams(url),
    });
  }

  return routes;
}

function extractBasePath(content: string): string {
  const match = content.match(/\.basePath\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  return match ? match[1] : "";
}

function normalizePath(urlPath: string): string {
  let normalized = urlPath.replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

/** Extracts params from Hono URLs: /users/:id or /users/{id} */
function extractHonoParams(url: string): string[] {
  const params: string[] = [];
  const colonRegex = /:(\w+)/g;
  const braceRegex = /\{(\w+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = colonRegex.exec(url)) !== null) params.push(match[1]);
  while ((match = braceRegex.exec(url)) !== null) params.push(match[1]);

  return params;
}

// ---------------------------------------------------------------------------
// Framework-specific checks
// ---------------------------------------------------------------------------

function getFrameworkChecks(): FrameworkCheck[] {
  return [
    {
      id: "hono-missing-error-handler",
      name: "Missing Hono error handler",
      description: "Hono apps should use app.onError() for centralized error handling.",
      check: checkMissingErrorHandler,
    },
    {
      id: "hono-missing-not-found",
      name: "Missing Hono 404 handler",
      description: "Hono apps should use app.notFound() for custom 404 responses.",
      check: checkMissing404Handler,
    },
    {
      id: "hono-unvalidated-mutation",
      name: "Mutation without Hono validator",
      description:
        "POST/PUT/PATCH routes should use zValidator or validator middleware for input validation.",
      check: checkUnvalidatedMutations,
    },
  ];
}

async function checkMissingErrorHandler(
  projectPath: string,
  _routes: RouteInfo[],
): Promise<Issue[]> {
  const files = await findHonoEntryFiles(projectPath);
  const timestamp = new Date().toISOString();

  for (const { content } of files) {
    if (/\.onError\s*\(/.test(content)) return [];
  }

  if (files.length === 0) return [];

  return [
    {
      id: "",
      category: "error-handling",
      severity: "warning",
      title: "Missing Hono error handler",
      description:
        "No app.onError() found. Add a centralized error handler for production-ready error responses.",
      file: files[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

async function checkMissing404Handler(projectPath: string, _routes: RouteInfo[]): Promise<Issue[]> {
  const files = await findHonoEntryFiles(projectPath);
  const timestamp = new Date().toISOString();

  for (const { content } of files) {
    if (/\.notFound\s*\(/.test(content)) return [];
  }

  if (files.length === 0) return [];

  return [
    {
      id: "",
      category: "error-handling",
      severity: "info",
      title: "Missing Hono 404 handler",
      description:
        "No app.notFound() found. Add a custom 404 handler instead of relying on Hono's default.",
      file: files[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

async function checkUnvalidatedMutations(
  _projectPath: string,
  routes: RouteInfo[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();

  for (const route of routes) {
    for (const method of route.methods) {
      if (["POST", "PUT", "PATCH"].includes(method.method) && !method.hasValidation) {
        issues.push({
          id: "",
          category: "validation",
          severity: "warning",
          title: `Hono mutation without validation: ${method.method} ${route.url}`,
          description:
            "This route accepts data but has no validation. Use zValidator() middleware or Hono's built-in validator.",
          file: route.filePath,
          line: method.lineNumber,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }
  }

  return issues;
}

async function findHonoEntryFiles(
  projectPath: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const candidates = await glob(
    "{app,server,index,main,src/app,src/server,src/index,src/main,src/api/[[]*]/*.{ts,js}",
    { cwd: projectPath, absolute: true, nodir: true },
  );

  const results: Array<{ filePath: string; content: string }> = [];
  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (/hono|Hono/i.test(content)) results.push({ filePath, content });
    } catch {
      /* skip: unreadable file */
    }
  }

  return results;
}
