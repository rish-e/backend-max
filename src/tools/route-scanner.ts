// =============================================================================
// backend-max — Multi-framework route scanner
// =============================================================================

import { glob } from "glob";
import type { FrameworkAnalyzer } from "../analyzers/framework-interface.js";
import { extractDynamicParams, filePathToUrl, findAppDir } from "../analyzers/nextjs.js";
import { detectFramework } from "../analyzers/registry.js";
import { createProject, extractExportedMethods } from "../analyzers/typescript.js";
import type { Issue, MethodInfo, RouteInfo, ScanResult } from "../types.js";

/**
 * Scans a project for all route handler files and extracts detailed
 * information about each exported HTTP method handler.
 *
 * The scanner:
 * 1. Auto-detects the framework via the analyzer registry
 * 2. For Next.js: uses the legacy scanning path (app dir + route files)
 * 3. For Express: delegates to the Express analyzer
 * 4. Runs framework-specific checks via getFrameworkChecks()
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            A ScanResult containing all discovered routes and a summary.
 */
export async function scanRoutes(projectPath: string): Promise<ScanResult> {
  const analyzer = await detectFramework(projectPath);

  // If an Express (or other non-Next.js) analyzer is detected, delegate fully
  if (analyzer && analyzer.name !== "nextjs") {
    return scanWithAnalyzer(projectPath, analyzer);
  }

  // Default: Next.js scanning path (preserved for backward compatibility)
  return scanNextJSRoutes(projectPath);
}

/**
 * Runs framework-specific checks from the detected analyzer.
 *
 * @param projectPath  Absolute path to the project root.
 * @param routes       Routes already discovered by the scanner.
 * @returns            Array of issues found by framework checks.
 */
export async function runFrameworkChecks(
  projectPath: string,
  routes: RouteInfo[],
): Promise<Issue[]> {
  const analyzer = await detectFramework(projectPath);
  if (!analyzer) return [];

  const checks = analyzer.getFrameworkChecks();
  const issues: Issue[] = [];

  for (const check of checks) {
    try {
      const checkIssues = await check.check(projectPath, routes);
      issues.push(...checkIssues);
    } catch (e) {
      console.error("[route-scanner] Framework check failed:", e instanceof Error ? e.message : e);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Generic analyzer delegation
// ---------------------------------------------------------------------------

/**
 * Scans routes using a non-Next.js FrameworkAnalyzer.
 */
async function scanWithAnalyzer(
  projectPath: string,
  analyzer: FrameworkAnalyzer,
): Promise<ScanResult> {
  const routes = await analyzer.scanRoutes(projectPath);

  // Sort for deterministic output
  routes.sort((a, b) => a.url.localeCompare(b.url));

  const totalEndpoints = routes.reduce((sum, r) => sum + r.methods.length, 0);

  const frameworksDetected = new Set<string>([analyzer.name]);

  // Detect additional frameworks from handler analysis
  for (const route of routes) {
    for (const method of route.methods) {
      if (method.hasDatabaseCalls) {
        for (const call of method.databaseCalls) {
          if (call.startsWith("prisma")) frameworksDetected.add("prisma");
          if (call.startsWith("db.")) frameworksDetected.add("drizzle");
        }
      }
      if (method.hasValidation) frameworksDetected.add("zod");
    }
  }

  return {
    routes,
    summary: {
      totalRoutes: routes.length,
      totalEndpoints,
      frameworksDetected: Array.from(frameworksDetected),
    },
  };
}

// ---------------------------------------------------------------------------
// Next.js scanning (legacy path — preserved for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Scans a Next.js project for all route handler files.
 */
async function scanNextJSRoutes(projectPath: string): Promise<ScanResult> {
  const appDir = await findAppDir(projectPath);

  if (!appDir) {
    return {
      routes: [],
      summary: {
        totalRoutes: 0,
        totalEndpoints: 0,
        frameworksDetected: [],
      },
    };
  }

  // Discover all route files
  const routeFiles = await glob("**/route.{ts,js}", {
    cwd: appDir,
    absolute: true,
    nodir: true,
  });

  if (routeFiles.length === 0) {
    return {
      routes: [],
      summary: {
        totalRoutes: 0,
        totalEndpoints: 0,
        frameworksDetected: ["nextjs"],
      },
    };
  }

  const project = createProject(projectPath);
  const routes: RouteInfo[] = [];
  const frameworksDetected = new Set<string>(["nextjs"]);

  for (const filePath of routeFiles) {
    try {
      const routeInfo = analyzeRouteFile(filePath, appDir, project);
      if (routeInfo) {
        routes.push(routeInfo);

        // Detect additional frameworks from handler analysis
        for (const method of routeInfo.methods) {
          if (method.hasDatabaseCalls) {
            for (const call of method.databaseCalls) {
              if (call.startsWith("prisma")) frameworksDetected.add("prisma");
              if (call.startsWith("db.")) frameworksDetected.add("drizzle");
            }
          }
          if (method.hasValidation) frameworksDetected.add("zod");
        }
      }
    } catch (error) {
      // Log but don't fail — continue scanning other files
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[route-scanner] Failed to analyze ${filePath}: ${message}`);
    }
  }

  // Sort routes by URL for deterministic output
  routes.sort((a, b) => a.url.localeCompare(b.url));

  const totalEndpoints = routes.reduce((sum, r) => sum + r.methods.length, 0);

  return {
    routes,
    summary: {
      totalRoutes: routes.length,
      totalEndpoints,
      frameworksDetected: Array.from(frameworksDetected),
    },
  };
}

/**
 * Analyzes a single route file and returns a RouteInfo object.
 *
 * @param filePath  Absolute path to the route file.
 * @param appDir    Absolute path to the app/ directory.
 * @param project   ts-morph Project instance for parsing.
 * @returns         RouteInfo or null if the file has no valid handlers.
 */
function analyzeRouteFile(
  filePath: string,
  appDir: string,
  project: ReturnType<typeof createProject>,
): RouteInfo | null {
  let sourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(filePath);
  } catch {
    /* skip: unreadable/unparseable file */
    return null;
  }

  const url = filePathToUrl(filePath, appDir);
  const dynamicParams = extractDynamicParams(url);
  const methods: MethodInfo[] = extractExportedMethods(sourceFile);

  // If no HTTP methods are exported, it's not a valid route handler
  if (methods.length === 0) {
    return null;
  }

  return {
    filePath,
    url,
    methods,
    dynamicParams,
  };
}
