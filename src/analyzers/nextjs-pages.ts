// =============================================================================
// backend-max — Next.js Pages Router API route analyzer
// =============================================================================

import { join, posix, relative, sep } from "node:path";
import { glob } from "glob";
import type { Node, SourceFile } from "ts-morph";
import type { MethodInfo, RouteInfo } from "../types.js";
import { extractDynamicParams } from "./nextjs.js";
import {
  createProject,
  detectAuthPatterns,
  detectDatabaseCalls,
  detectErrorHandling,
  detectValidation,
} from "./typescript.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a Pages Router API file path to a URL pattern.
 *
 * Pages Router conventions:
 * - `pages/api/users/[id].ts` => `/api/users/[id]`
 * - `src/pages/api/health.ts` => `/api/health`
 * - Index files: `pages/api/index.ts` => `/api`
 *
 * @param filePath  Absolute path to the API route file.
 * @param pagesDir  Absolute path to the `pages/` directory.
 * @returns URL pattern string.
 */
function pagesFilePathToUrl(filePath: string, pagesDir: string): string {
  const rel = relative(pagesDir, filePath).split(sep).join(posix.sep);

  // Remove .ts / .js extension
  const withoutExt = rel.replace(/\.(ts|js)$/, "");

  // Remove trailing /index
  const withoutIndex = withoutExt.replace(/\/index$/, "");

  // Build URL: pages dir already includes "api" prefix in the glob
  const url = `/${withoutIndex}`;
  return url === "/" ? "/" : url;
}

/**
 * Extracts HTTP methods from a Pages Router handler by looking for
 * `req.method` comparisons inside the default export function.
 *
 * Patterns detected:
 * - `if (req.method === 'GET') { ... }`
 * - `switch (req.method) { case 'POST': ... }`
 * - `req.method === "PUT"`
 *
 * @param sourceFile - The ts-morph SourceFile to analyze.
 * @returns Array of HTTP method strings found, or ["GET"] as default.
 */
function extractMethodsFromHandler(sourceFile: SourceFile): string[] {
  const text = sourceFile.getFullText();
  const methods = new Set<string>();

  // Match req.method === "X" or req.method === 'X'
  const comparisonRegex =
    /req\.method\s*===?\s*["'`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["'`]/gi;
  let match: RegExpExecArray | null;
  while ((match = comparisonRegex.exec(text)) !== null) {
    methods.add(match[1].toUpperCase());
  }

  // Match case "X": in switch statements
  const caseRegex = /case\s+["'`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["'`]\s*:/gi;
  while ((match = caseRegex.exec(text)) !== null) {
    methods.add(match[1].toUpperCase());
  }

  // If no methods detected, assume GET (common for simple handlers)
  if (methods.size === 0) {
    methods.add("GET");
  }

  return Array.from(methods);
}

/**
 * Finds the default export function body node in a Pages Router file.
 *
 * Supports:
 * - `export default function handler(req, res) { ... }`
 * - `export default async function handler(req, res) { ... }`
 * - `export default async (req, res) => { ... }`
 * - `function handler(req, res) { ... } export default handler;`
 */
function findDefaultExportBody(sourceFile: SourceFile): Node | null {
  // Check for `export default function ...`
  const defaultExport = sourceFile.getDefaultExportSymbol();
  if (defaultExport) {
    const declarations = defaultExport.getDeclarations();
    if (declarations.length > 0) {
      return declarations[0];
    }
  }

  // Fallback: look for any exported function
  for (const func of sourceFile.getFunctions()) {
    if (func.isDefaultExport() || func.isExported()) {
      return func;
    }
  }

  // Fallback: look for export default assignment (arrow function)
  for (const exportDecl of sourceFile.getExportAssignments()) {
    const expr = exportDecl.getExpression();
    if (expr) {
      return expr;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans a Next.js Pages Router project for API routes in `pages/api/` or
 * `src/pages/api/` directories.
 *
 * Each `.ts` or `.js` file under `pages/api/` is treated as a route handler.
 * The function analyzes each file for:
 * - Supported HTTP methods (via `req.method` checks)
 * - Validation patterns
 * - Error handling
 * - Database calls
 * - Auth patterns
 *
 * @param projectPath - Absolute path to the project root.
 * @returns Array of RouteInfo compatible with the rest of the system.
 */
export async function scanPagesApiRoutes(projectPath: string): Promise<RouteInfo[]> {
  // Look for pages/api and src/pages/api
  const candidates = [
    { dir: join(projectPath, "pages"), prefix: "pages" },
    { dir: join(projectPath, "src", "pages"), prefix: "src/pages" },
  ];

  let pagesDir: string | null = null;
  let apiFiles: string[] = [];

  for (const { dir } of candidates) {
    const files = await glob("api/**/*.{ts,js}", {
      cwd: dir,
      absolute: true,
      nodir: true,
      ignore: ["**/*.d.ts", "**/*.test.ts", "**/*.spec.ts"],
    }).catch(() => [] as string[]);

    if (files.length > 0) {
      pagesDir = dir;
      apiFiles = files;
      break;
    }
  }

  if (!pagesDir || apiFiles.length === 0) {
    return [];
  }

  const project = createProject(projectPath);
  const routes: RouteInfo[] = [];

  for (const filePath of apiFiles) {
    try {
      let sourceFile: SourceFile;
      try {
        sourceFile = project.addSourceFileAtPath(filePath);
      } catch {
        /* skip: unreadable/unparseable file */
        continue;
      }

      const url = pagesFilePathToUrl(filePath, pagesDir);
      const dynamicParams = extractDynamicParams(url);

      // Find the handler body for analysis
      const handlerBody = findDefaultExportBody(sourceFile);
      if (!handlerBody) {
        // No default export — might not be a valid API route
        continue;
      }

      // Extract HTTP methods from req.method checks
      const httpMethods = extractMethodsFromHandler(sourceFile);

      // Build MethodInfo for each detected method
      const methods: MethodInfo[] = httpMethods.map((method) => ({
        method,
        hasValidation: detectValidation(handlerBody),
        hasErrorHandling: detectErrorHandling(handlerBody),
        hasDatabaseCalls: detectDatabaseCalls(handlerBody).length > 0,
        hasAuth: detectAuthPatterns(handlerBody),
        returnType: null,
        databaseCalls: detectDatabaseCalls(handlerBody),
        lineNumber: handlerBody.getStartLineNumber(),
      }));

      routes.push({
        filePath,
        url,
        methods,
        dynamicParams,
      });
    } catch {
      /* skip: unreadable/unparseable file */
    }
  }

  // Sort for deterministic output
  routes.sort((a, b) => a.url.localeCompare(b.url));

  return routes;
}
