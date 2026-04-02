// =============================================================================
// backend-max — Living API documentation generator
// =============================================================================

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiGraph, MethodInfo, RouteInfo, ScanResult } from "../types.js";
import { ensureDir, getTimestamp, relativePath, writeJson } from "../utils/helpers.js";
import { buildApiGraph } from "./api-graph.js";
import { scanRoutes } from "./route-scanner.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** Subdirectory for generated documentation. */
const DOCS_DIR = "api-docs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Groups routes by the first path segment after /api/.
 * Routes outside /api/ are grouped under "other".
 */
function groupByDomain(routes: RouteInfo[]): Map<string, RouteInfo[]> {
  const groups = new Map<string, RouteInfo[]>();

  for (const route of routes) {
    const segments = route.url.split("/").filter(Boolean);
    // Expect ["api", "domain", ...]
    let domain = "other";
    const apiIdx = segments.indexOf("api");
    if (apiIdx !== -1 && apiIdx + 1 < segments.length) {
      domain = segments[apiIdx + 1];
    }

    const group = groups.get(domain) ?? [];
    group.push(route);
    groups.set(domain, group);
  }

  return groups;
}

/**
 * Generates the Markdown section for a single route method,
 * optionally enriched with API graph data.
 */
function methodSection(
  route: RouteInfo,
  method: MethodInfo,
  projectPath: string,
  graph?: ApiGraph,
): string {
  const relFile = relativePath(projectPath, route.filePath);
  const dbCalls = method.databaseCalls.length > 0 ? method.databaseCalls.join(", ") : "none";

  const lines = [
    `### ${method.method} ${route.url}`,
    "",
    `- **File:** \`${relFile}\` (line ${method.lineNumber})`,
    `- **Auth:** ${method.hasAuth ? "yes" : "no"}`,
    `- **Validation:** ${method.hasValidation ? "yes" : "no"}`,
    `- **Database:** ${dbCalls}`,
    `- **Error Handling:** ${method.hasErrorHandling ? "yes" : "no"}`,
  ];

  if (method.returnType) {
    lines.push(`- **Return Type:** \`${method.returnType}\``);
  }

  if (route.dynamicParams.length > 0) {
    lines.push(`- **Dynamic Params:** ${route.dynamicParams.join(", ")}`);
  }

  // Enrich with graph data if available
  if (graph) {
    const routeNodeId = `route:${method.method} ${route.url}`;

    // "Called by" — frontend components that call this endpoint
    const callers = graph.edges
      .filter((e) => e.type === "calls" && e.to === routeNodeId)
      .map((e) => {
        const node = graph.nodes.find((n) => n.id === e.from);
        return node ? node.name : e.from;
      });
    if (callers.length > 0) {
      lines.push(`- **Called by:** ${callers.map((c) => `\`${c}\``).join(", ")}`);
    }

    // "Writes to" — models this endpoint writes to
    const writesTo = graph.edges
      .filter((e) => e.type === "writes" && e.from === routeNodeId)
      .map((e) => {
        const node = graph.nodes.find((n) => n.id === e.to);
        return node ? node.name : e.to;
      });
    if (writesTo.length > 0) {
      lines.push(`- **Writes to:** ${writesTo.join(", ")}`);
    }

    // "Reads from" — models this endpoint reads from
    const readsFrom = graph.edges
      .filter((e) => e.type === "reads" && e.from === routeNodeId)
      .map((e) => {
        const node = graph.nodes.find((n) => n.id === e.to);
        return node ? node.name : e.to;
      });
    if (readsFrom.length > 0) {
      lines.push(`- **Reads from:** ${readsFrom.join(", ")}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates living API documentation by scanning all routes and producing
 * a grouped Markdown file.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns The generated Markdown string.
 */
export async function generateDocs(projectPath: string): Promise<string> {
  const docsDir = join(projectPath, STATE_DIR, DOCS_DIR);
  await ensureDir(docsDir);

  // Scan all routes
  const scanResult: ScanResult = await scanRoutes(projectPath);
  const { routes, summary } = scanResult;

  // Build the API graph for enriched docs
  let graph: ApiGraph | undefined;
  try {
    graph = await buildApiGraph(projectPath);
    // Save graph to disk
    const graphPath = join(projectPath, STATE_DIR, "api-graph.json");
    await writeJson(graphPath, graph);
  } catch {
    // Graph building may fail — fall back to basic docs
  }

  // Group by domain
  const grouped = groupByDomain(routes);

  // Build Markdown
  const sections: string[] = [];

  // Header & summary
  sections.push("# API Documentation");
  sections.push("");
  sections.push(`> Auto-generated by backend-max on ${getTimestamp()}`);
  sections.push("");
  sections.push("## Summary");
  sections.push("");
  sections.push(`| Metric | Value |`);
  sections.push(`|--------|-------|`);
  sections.push(`| Total Routes | ${summary.totalRoutes} |`);
  sections.push(`| Total Endpoints | ${summary.totalEndpoints} |`);
  sections.push(`| Frameworks | ${summary.frameworksDetected.join(", ") || "none"} |`);
  sections.push(`| Domains | ${Array.from(grouped.keys()).join(", ")} |`);
  sections.push("");
  sections.push("---");
  sections.push("");

  // Domain sections
  const sortedDomains = Array.from(grouped.keys()).sort();

  for (const domain of sortedDomains) {
    const domainRoutes = grouped.get(domain)!;
    const domainTitle = domain.charAt(0).toUpperCase() + domain.slice(1);
    sections.push(`## ${domainTitle}`);
    sections.push("");

    for (const route of domainRoutes) {
      for (const method of route.methods) {
        sections.push(methodSection(route, method, projectPath, graph));
      }
    }

    sections.push("---");
    sections.push("");
  }

  const markdown = sections.join("\n");

  // Save to disk
  const outputPath = join(docsDir, "routes.md");
  await writeFile(outputPath, markdown, "utf-8");

  return markdown;
}

/**
 * Generates a changelog comparing two route scan results.
 *
 * @param projectPath    - Absolute path to the project root.
 * @param previousRoutes - The previous ScanResult (or its routes array).
 * @param currentRoutes  - The current ScanResult (or its routes array).
 * @returns The generated changelog Markdown.
 */
export function generateChangelog(
  projectPath: string,
  previousRoutes: ScanResult | RouteInfo[],
  currentRoutes: ScanResult | RouteInfo[],
): string {
  const prev = Array.isArray(previousRoutes) ? previousRoutes : previousRoutes.routes;
  const curr = Array.isArray(currentRoutes) ? currentRoutes : currentRoutes.routes;

  // Build lookup maps: "METHOD /url" -> RouteInfo
  const prevMap = new Map<string, RouteInfo>();
  for (const route of prev) {
    for (const method of route.methods) {
      prevMap.set(`${method.method} ${route.url}`, route);
    }
  }

  const currMap = new Map<string, RouteInfo>();
  for (const route of curr) {
    for (const method of route.methods) {
      currMap.set(`${method.method} ${route.url}`, route);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  // Detect added and modified
  for (const [key, route] of currMap.entries()) {
    if (!prevMap.has(key)) {
      added.push(key);
    } else {
      const prevRoute = prevMap.get(key)!;
      if (prevRoute.filePath !== route.filePath) {
        modified.push(`${key} (file moved)`);
      }
    }
  }

  // Detect removed
  for (const key of prevMap.keys()) {
    if (!currMap.has(key)) {
      removed.push(key);
    }
  }

  // Build Markdown
  const sections: string[] = [];
  sections.push("# API Changelog");
  sections.push("");
  sections.push(`> Generated on ${getTimestamp()}`);
  sections.push("");

  if (added.length === 0 && removed.length === 0 && modified.length === 0) {
    sections.push("No changes detected.");
    return sections.join("\n");
  }

  if (added.length > 0) {
    sections.push("## Added Endpoints");
    sections.push("");
    for (const endpoint of added) {
      sections.push(`- \`${endpoint}\``);
    }
    sections.push("");
  }

  if (removed.length > 0) {
    sections.push("## Removed Endpoints");
    sections.push("");
    for (const endpoint of removed) {
      sections.push(`- \`${endpoint}\``);
    }
    sections.push("");
  }

  if (modified.length > 0) {
    sections.push("## Modified Endpoints");
    sections.push("");
    for (const endpoint of modified) {
      sections.push(`- \`${endpoint}\``);
    }
    sections.push("");
  }

  const markdown = sections.join("\n");

  // Save changelog (fire-and-forget write — this is a sync return)
  const changelogPath = join(projectPath, STATE_DIR, DOCS_DIR, "changelog.md");
  ensureDir(join(projectPath, STATE_DIR, DOCS_DIR))
    .then(() => writeFile(changelogPath, markdown, "utf-8"))
    .catch(() => {
      // Non-critical — don't blow up if we can't write
    });

  return markdown;
}
