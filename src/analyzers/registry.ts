// =============================================================================
// backend-max — Framework analyzer registry
// =============================================================================

import { createExpressAnalyzer } from "./express.js";
import { createFastifyAnalyzer } from "./fastify.js";
import type { FrameworkAnalyzer } from "./framework-interface.js";
import { createGraphQLAnalyzer } from "./graphql.js";
import { createHonoAnalyzer } from "./hono.js";
import { createNextJSAnalyzer } from "./nextjs.js";
import { createTRPCAnalyzer } from "./trpc.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All registered framework analyzers, ordered by detection priority. */
const analyzers: FrameworkAnalyzer[] = [
  createNextJSAnalyzer(),
  createTRPCAnalyzer(),
  createGraphQLAnalyzer(),
  createFastifyAnalyzer(),
  createHonoAnalyzer(),
  createExpressAnalyzer(),
];

/**
 * Auto-detects the framework used in a project by running each analyzer's
 * `detect` method in order. Returns the first match, or null if none match.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns The matching FrameworkAnalyzer, or null.
 */
export async function detectFramework(projectPath: string): Promise<FrameworkAnalyzer | null> {
  for (const analyzer of analyzers) {
    try {
      const detected = await analyzer.detect(projectPath);
      if (detected) {
        return analyzer;
      }
    } catch {
      // Detection failure should not block other analyzers
    }
  }
  return null;
}

/**
 * Returns an analyzer by framework name.
 *
 * @param framework  Framework identifier (e.g. "nextjs", "express").
 * @returns The matching FrameworkAnalyzer, or null.
 */
export function getAnalyzer(framework: string): FrameworkAnalyzer | null {
  return analyzers.find((a) => a.name === framework) ?? null;
}

/**
 * Returns all registered framework analyzers.
 */
export function getAllAnalyzers(): FrameworkAnalyzer[] {
  return [...analyzers];
}
