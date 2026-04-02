// =============================================================================
// backend-max — Framework Analyzer Interface
// =============================================================================

import type { Issue, RouteInfo } from "../types.js";

/**
 * Framework Analyzer Interface.
 * All framework-specific analyzers must implement this interface.
 */
export interface FrameworkAnalyzer {
  /** Framework identifier (e.g. "nextjs", "express"). */
  name: string;

  /** Detect if this framework is used in the project. */
  detect(projectPath: string): Promise<boolean>;

  /** Scan all routes/endpoints for this framework. */
  scanRoutes(projectPath: string): Promise<RouteInfo[]>;

  /** Get framework-specific checks to run. */
  getFrameworkChecks(): FrameworkCheck[];
}

/**
 * A framework-specific diagnostic check.
 */
export interface FrameworkCheck {
  /** Unique check identifier (e.g. "express-missing-error-middleware"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this check looks for. */
  description: string;
  /** Execute the check against a project and its discovered routes. */
  check: (projectPath: string, routes: RouteInfo[]) => Promise<Issue[]>;
}
