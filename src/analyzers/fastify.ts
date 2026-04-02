// =============================================================================
// backend-max — Fastify route analyzer
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

/** Fastify HTTP methods we scan for. */
const FASTIFY_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "all",
] as const;

/** Patterns that indicate Fastify route definitions. */
const ROUTE_CALL_REGEX = new RegExp(
  `(?:fastify|app|server|instance)\\.(${FASTIFY_METHODS.join("|")})\\s*\\(`,
  "g",
);

/** Pattern for Fastify route shorthand with schema. */
const _SCHEMA_ROUTE_REGEX =
  /\.(?:get|post|put|delete|patch)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*\{[^}]*schema\s*:/;

/** Pattern for Fastify plugin registration. */
const _PLUGIN_REGEX = /(?:fastify|app|server)\.register\s*\(/g;

/** Pattern for route prefix in plugin opts. */
const _PREFIX_REGEX = /prefix\s*:\s*['"`]([^'"`]+)['"`]/;

// ---------------------------------------------------------------------------
// Fastify Analyzer
// ---------------------------------------------------------------------------

export function createFastifyAnalyzer(): FrameworkAnalyzer {
  return {
    name: "fastify",
    detect,
    scanRoutes: scanFastifyRoutes,
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
    return "fastify" in deps || "fastify" in devDeps;
  } catch {
    /* skip: unreadable/unparseable package.json */
    return false;
  }
}

async function scanFastifyRoutes(projectPath: string): Promise<RouteInfo[]> {
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

  const routeFiles: Array<{ filePath: string; content: string }> = [];

  for (const filePath of sourceFiles) {
    try {
      const content = await readFile(filePath, "utf-8");
      ROUTE_CALL_REGEX.lastIndex = 0;
      if (ROUTE_CALL_REGEX.test(content)) {
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
      const routes = analyzeFastifyFile(filePath, content, project);
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

function analyzeFastifyFile(filePath: string, _content: string, project: Project): RouteInfo[] {
  let sourceFile: SourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(filePath);
  } catch {
    /* skip: unparseable file */
    return [];
  }

  const routeMap = new Map<string, MethodInfo[]>();

  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;

    const methodName = expr.getName().toLowerCase();
    if (!(FASTIFY_METHODS as readonly string[]).includes(methodName)) continue;

    const objText = expr.getExpression().getText();
    if (!["fastify", "app", "server", "instance"].includes(objText)) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    // First arg is URL pattern
    const firstArg = args[0];
    let urlPattern = firstArg.getText().replace(/^['"`]|['"`]$/g, "");
    if (urlPattern.startsWith("(") || urlPattern.startsWith("{")) continue;

    if (!urlPattern.startsWith("/")) urlPattern = `/${urlPattern}`;

    const httpMethod = methodName === "all" ? "ALL" : methodName.toUpperCase();

    // Check if second arg is options object with schema (Fastify schema validation)
    let hasSchemaValidation = false;
    if (args.length >= 2) {
      const secondArg = args[1];
      const secondText = secondArg.getText();
      if (/schema\s*:/.test(secondText)) {
        hasSchemaValidation = true;
      }
    }

    // Handler is the last argument
    const handler = args[args.length - 1];
    const dbCalls = detectDatabaseCalls(handler);

    const methodInfo: MethodInfo = {
      method: httpMethod,
      hasValidation: hasSchemaValidation || detectValidation(handler),
      hasErrorHandling: detectErrorHandling(handler),
      hasDatabaseCalls: dbCalls.length > 0,
      hasAuth: detectAuthPatterns(handler),
      returnType: null,
      databaseCalls: dbCalls,
      lineNumber: call.getStartLineNumber(),
    };

    if (!routeMap.has(urlPattern)) {
      routeMap.set(urlPattern, []);
    }
    routeMap.get(urlPattern)?.push(methodInfo);
  }

  const routes: RouteInfo[] = [];
  for (const [url, methods] of routeMap) {
    routes.push({
      filePath,
      url,
      methods,
      dynamicParams: extractFastifyParams(url),
    });
  }

  return routes;
}

/** Extracts Fastify-style params from URL: /users/:id or /users/<id> */
function extractFastifyParams(url: string): string[] {
  const params: string[] = [];
  const colonRegex = /:(\w+)/g;
  const angleRegex = /<(\w+)>/g;
  let match: RegExpExecArray | null;

  while ((match = colonRegex.exec(url)) !== null) params.push(match[1]);
  while ((match = angleRegex.exec(url)) !== null) params.push(match[1]);

  return params;
}

// ---------------------------------------------------------------------------
// Framework-specific checks
// ---------------------------------------------------------------------------

function getFrameworkChecks(): FrameworkCheck[] {
  return [
    {
      id: "fastify-missing-schema-validation",
      name: "Route without Fastify schema validation",
      description:
        "Fastify supports built-in JSON Schema validation via the schema option. Routes with mutation methods should use it.",
      check: checkMissingSchemaValidation,
    },
    {
      id: "fastify-missing-error-handler",
      name: "Missing custom error handler",
      description:
        "Fastify apps should set a custom error handler with setErrorHandler() for production-ready error responses.",
      check: checkMissingErrorHandler,
    },
    {
      id: "fastify-missing-not-found-handler",
      name: "Missing 404 handler",
      description: "Fastify apps should set a custom 404 handler with setNotFoundHandler().",
      check: checkMissing404Handler,
    },
  ];
}

async function checkMissingSchemaValidation(
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
          title: `Fastify route without schema validation: ${method.method} ${route.url}`,
          description:
            "This mutation route doesn't use Fastify's built-in schema validation. Add a schema option with body/params/querystring definitions.",
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

async function checkMissingErrorHandler(
  projectPath: string,
  _routes: RouteInfo[],
): Promise<Issue[]> {
  const entryFiles = await findFastifyEntryFiles(projectPath);
  const timestamp = new Date().toISOString();

  for (const { content } of entryFiles) {
    if (/setErrorHandler\s*\(/.test(content)) return [];
  }

  if (entryFiles.length === 0) return [];

  return [
    {
      id: "",
      category: "error-handling",
      severity: "warning",
      title: "Missing Fastify custom error handler",
      description:
        "No setErrorHandler() found. Add a custom error handler for production-ready error responses.",
      file: entryFiles[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

async function checkMissing404Handler(projectPath: string, _routes: RouteInfo[]): Promise<Issue[]> {
  const entryFiles = await findFastifyEntryFiles(projectPath);
  const timestamp = new Date().toISOString();

  for (const { content } of entryFiles) {
    if (/setNotFoundHandler\s*\(/.test(content)) return [];
  }

  if (entryFiles.length === 0) return [];

  return [
    {
      id: "",
      category: "error-handling",
      severity: "info",
      title: "Missing Fastify 404 handler",
      description:
        "No setNotFoundHandler() found. Add a custom 404 handler instead of relying on Fastify's default.",
      file: entryFiles[0].filePath,
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    },
  ];
}

async function findFastifyEntryFiles(
  projectPath: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const candidates = await glob(
    "{app,server,index,main,src/app,src/server,src/index,src/main}.{ts,js}",
    { cwd: projectPath, absolute: true, nodir: true },
  );

  const results: Array<{ filePath: string; content: string }> = [];
  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (/fastify/i.test(content)) results.push({ filePath, content });
    } catch {
      /* skip: unreadable file */
    }
  }

  return results;
}
