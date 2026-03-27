// =============================================================================
// backend-max — Next.js route scanner
// =============================================================================

import { glob } from "glob";
import type { RouteInfo, MethodInfo, ScanResult } from "../types.js";
import {
  filePathToUrl,
  extractDynamicParams,
  findAppDir,
} from "../analyzers/nextjs.js";
import {
  createProject,
  extractExportedMethods,
} from "../analyzers/typescript.js";

/**
 * Scans a Next.js project for all route handler files and extracts detailed
 * information about each exported HTTP method handler.
 *
 * The scanner:
 * 1. Locates the `app/` directory (supports both `app/` and `src/app/`)
 * 2. Finds all `route.ts` and `route.js` files
 * 3. Parses file paths into URL patterns (stripping route groups, preserving dynamic segments)
 * 4. Uses ts-morph to analyze each handler for validation, error handling, database calls, and auth
 *
 * @param projectPath  Absolute path to the Next.js project root.
 * @returns            A ScanResult containing all discovered routes and a summary.
 */
export async function scanRoutes(projectPath: string): Promise<ScanResult> {
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
      const message =
        error instanceof Error ? error.message : String(error);
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
    // File can't be parsed — skip it
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
