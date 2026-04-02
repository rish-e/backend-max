// =============================================================================
// backend-max — Queryable API graph
// =============================================================================

import { scanFrontendCalls } from "../analyzers/frontend.js";
import { detectMiddleware } from "../analyzers/nextjs.js";
import type { ApiEdge, ApiGraph, ApiNode, ApiQueryResult, FrontendCall } from "../types.js";
import { scanRoutes } from "./route-scanner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a stable node ID from a type and name.
 */
function nodeId(type: string, name: string): string {
  return `${type}:${name}`;
}

/**
 * Extracts unique model names from database call expressions.
 * e.g., "prisma.user.findMany" => "user", "db.select" => "db"
 */
function extractModelsFromCalls(
  databaseCalls: string[],
): Array<{ model: string; isWrite: boolean }> {
  const results: Array<{ model: string; isWrite: boolean }> = [];
  const writeMethods = new Set([
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "upsert",
    "insert",
  ]);

  for (const call of databaseCalls) {
    // Prisma pattern: prisma.model.method
    const prismaMatch = call.match(/^prisma\.(\w+)\.(\w+)/);
    if (prismaMatch) {
      const model = prismaMatch[1];
      const method = prismaMatch[2];
      // Skip $-prefixed raw methods
      if (!model.startsWith("$")) {
        results.push({ model, isWrite: writeMethods.has(method) });
      }
      continue;
    }

    // Drizzle pattern: db.select/insert/update/delete
    const drizzleMatch = call.match(/^db\.(select|insert|update|delete)/);
    if (drizzleMatch) {
      const method = drizzleMatch[1];
      results.push({
        model: "db",
        isWrite: method !== "select",
      });
    }
  }

  return results;
}

/**
 * Checks whether a route URL matches a middleware matcher pattern.
 */
function routeMatchesMatcher(routeUrl: string, matcher: string): boolean {
  // Simple prefix matching (common middleware pattern)
  if (matcher.endsWith("/:path*") || matcher.endsWith("(.*)")) {
    const prefix = matcher.replace(/\/:[^/]+\*$/, "").replace(/\(\.\*\)$/, "");
    return routeUrl.startsWith(prefix);
  }
  // Exact match
  return routeUrl === matcher || routeUrl.startsWith(matcher);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a queryable graph representation of the project's API surface.
 *
 * The graph contains:
 * - Route nodes (from scanned API routes)
 * - Frontend-component nodes (from frontend fetch/axios calls)
 * - Model nodes (from database call analysis)
 * - Middleware nodes (from middleware detection)
 * - Edges: "calls", "reads", "writes", "protects", "validates"
 *
 * @param projectPath - Absolute path to the project root.
 * @returns The API graph with nodes and edges.
 */
export async function buildApiGraph(projectPath: string): Promise<ApiGraph> {
  const nodes: ApiNode[] = [];
  const edges: ApiEdge[] = [];
  const seenNodes = new Set<string>();

  // 1. Scan routes => route nodes
  const scanResult = await scanRoutes(projectPath);
  for (const route of scanResult.routes) {
    for (const method of route.methods) {
      const id = nodeId("route", `${method.method} ${route.url}`);
      if (!seenNodes.has(id)) {
        seenNodes.add(id);
        nodes.push({
          id,
          type: "route",
          name: `${method.method} ${route.url}`,
          metadata: {
            filePath: route.filePath,
            hasAuth: method.hasAuth,
            hasValidation: method.hasValidation,
            hasErrorHandling: method.hasErrorHandling,
            databaseCalls: method.databaseCalls,
            lineNumber: method.lineNumber,
            dynamicParams: route.dynamicParams,
          },
        });
      }

      // Validation edges
      if (method.hasValidation) {
        edges.push({
          from: `validation:${method.method} ${route.url}`,
          to: id,
          type: "validates",
        });
      }

      // Database edges => model nodes + read/write edges
      const models = extractModelsFromCalls(method.databaseCalls);
      for (const { model, isWrite } of models) {
        const modelId = nodeId("model", model);
        if (!seenNodes.has(modelId)) {
          seenNodes.add(modelId);
          nodes.push({
            id: modelId,
            type: "model",
            name: model,
            metadata: {},
          });
        }
        edges.push({
          from: id,
          to: modelId,
          type: isWrite ? "writes" : "reads",
        });
      }
    }
  }

  // 2. Scan frontend calls => frontend-component nodes + "calls" edges
  try {
    const frontendCalls = await scanFrontendCalls(projectPath);
    const componentFiles = new Map<string, FrontendCall[]>();

    for (const call of frontendCalls) {
      const existing = componentFiles.get(call.file) ?? [];
      existing.push(call);
      componentFiles.set(call.file, existing);
    }

    for (const [file, calls] of componentFiles.entries()) {
      const componentId = nodeId("frontend-component", file);
      if (!seenNodes.has(componentId)) {
        seenNodes.add(componentId);
        nodes.push({
          id: componentId,
          type: "frontend-component",
          name: file,
          metadata: { callCount: calls.length },
        });
      }

      for (const call of calls) {
        // Find matching route node
        const routeId = nodeId("route", `${call.method} ${call.url}`);
        edges.push({
          from: componentId,
          to: routeId,
          type: "calls",
        });
      }
    }
  } catch {
    // Frontend scan may fail — non-fatal
  }

  // 3. Detect middleware => middleware nodes + "protects" edges
  try {
    const middleware = await detectMiddleware(projectPath);
    if (middleware) {
      const middlewareId = nodeId("middleware", middleware.filePath);
      if (!seenNodes.has(middlewareId)) {
        seenNodes.add(middlewareId);
        nodes.push({
          id: middlewareId,
          type: "middleware",
          name: "middleware",
          metadata: {
            filePath: middleware.filePath,
            hasAuth: middleware.hasAuth,
            hasRedirects: middleware.hasRedirects,
            hasHeaders: middleware.hasHeaders,
            matchers: middleware.matchers,
          },
        });
      }

      // Connect middleware to routes it protects
      for (const route of scanResult.routes) {
        for (const method of route.methods) {
          const routeId = nodeId("route", `${method.method} ${route.url}`);
          const isProtected =
            middleware.matchers.length === 0 ||
            middleware.matchers.some((m) => routeMatchesMatcher(route.url, m));

          if (isProtected && middleware.hasAuth) {
            edges.push({
              from: middlewareId,
              to: routeId,
              type: "protects",
            });
          }
        }
      }
    }
  } catch {
    // Middleware detection may fail — non-fatal
  }

  return { nodes, edges };
}

/**
 * Queries the API graph using simple keyword-based matching.
 *
 * Supported query patterns:
 * - "routes with auth" / "protected routes" — routes connected to middleware "protects" edges
 * - "unprotected routes" / "routes without auth" — routes without "protects" edges
 * - "routes that write to X" — follow "writes" edges to model X
 * - "routes that read from X" — follow "reads" edges from routes to model X
 * - "frontend components calling X" / "calling /api/X" — follow "calls" edges
 * - "unused models" — models with no incoming read/write edges
 * - "unused routes" — routes with no incoming "calls" edges
 *
 * @param graph - The API graph to query.
 * @param query - Natural language query string.
 * @returns Matching nodes and edges.
 */
export function queryApiGraph(graph: ApiGraph, query: string): ApiQueryResult {
  const q = query.toLowerCase().trim();
  const matchedNodes: ApiNode[] = [];
  const matchedEdges: ApiEdge[] = [];

  // Helper: get all edges pointing to a node
  const _edgesTo = (nodeId: string) => graph.edges.filter((e) => e.to === nodeId);
  const _edgesFrom = (nodeId: string) => graph.edges.filter((e) => e.from === nodeId);

  // "unprotected routes" / "routes without auth"
  if (q.includes("unprotected") || (q.includes("without") && q.includes("auth"))) {
    const protectedIds = new Set(graph.edges.filter((e) => e.type === "protects").map((e) => e.to));
    for (const node of graph.nodes) {
      if (node.type === "route" && !protectedIds.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      description: "Routes without auth protection",
    };
  }

  // "routes with auth" / "protected routes"
  if ((q.includes("with") && q.includes("auth")) || q.includes("protected")) {
    const protectedIds = new Set(graph.edges.filter((e) => e.type === "protects").map((e) => e.to));
    for (const node of graph.nodes) {
      if (node.type === "route" && protectedIds.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    const relevantEdges = graph.edges.filter((e) => e.type === "protects");
    matchedEdges.push(...relevantEdges);
    return { nodes: matchedNodes, edges: matchedEdges, description: "Routes with auth protection" };
  }

  // "routes that write to X" / "writing to X"
  const writeMatch = q.match(/(?:writ(?:e|ing|es)\s+(?:to\s+)?)(\w+)/);
  if (writeMatch) {
    const target = writeMatch[1].toLowerCase();
    const writeEdges = graph.edges.filter(
      (e) => e.type === "writes" && e.to.toLowerCase().includes(target),
    );
    const routeIds = new Set(writeEdges.map((e) => e.from));
    for (const node of graph.nodes) {
      if (routeIds.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    matchedEdges.push(...writeEdges);
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      description: `Routes that write to "${target}"`,
    };
  }

  // "routes that read from X" / "reading from X"
  const readMatch = q.match(/(?:read(?:ing|s)?\s+(?:from\s+)?)(\w+)/);
  if (readMatch) {
    const target = readMatch[1].toLowerCase();
    const readEdges = graph.edges.filter(
      (e) => e.type === "reads" && e.to.toLowerCase().includes(target),
    );
    const routeIds = new Set(readEdges.map((e) => e.from));
    for (const node of graph.nodes) {
      if (routeIds.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    matchedEdges.push(...readEdges);
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      description: `Routes that read from "${target}"`,
    };
  }

  // "frontend components calling X" / "calling /api/X" / "that call X"
  const callMatch = q.match(/call(?:ing|s)?\s+(.+)/);
  if (callMatch) {
    const target = callMatch[1].toLowerCase().trim();
    const callEdges = graph.edges.filter(
      (e) => e.type === "calls" && e.to.toLowerCase().includes(target),
    );
    const componentIds = new Set(callEdges.map((e) => e.from));
    for (const node of graph.nodes) {
      if (componentIds.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    matchedEdges.push(...callEdges);
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      description: `Components calling "${target}"`,
    };
  }

  // "unused models"
  if (q.includes("unused") && q.includes("model")) {
    const modelsWithEdges = new Set(
      graph.edges.filter((e) => e.type === "reads" || e.type === "writes").map((e) => e.to),
    );
    for (const node of graph.nodes) {
      if (node.type === "model" && !modelsWithEdges.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      description: "Models with no read/write edges",
    };
  }

  // "unused routes"
  if (q.includes("unused") && q.includes("route")) {
    const routesWithCallers = new Set(
      graph.edges.filter((e) => e.type === "calls").map((e) => e.to),
    );
    for (const node of graph.nodes) {
      if (node.type === "route" && !routesWithCallers.has(node.id)) {
        matchedNodes.push(node);
      }
    }
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      description: "Routes with no frontend callers",
    };
  }

  // Fallback: search by name substring
  for (const node of graph.nodes) {
    if (node.name.toLowerCase().includes(q) || node.id.toLowerCase().includes(q)) {
      matchedNodes.push(node);
    }
  }
  for (const edge of graph.edges) {
    if (edge.from.toLowerCase().includes(q) || edge.to.toLowerCase().includes(q)) {
      matchedEdges.push(edge);
    }
  }

  return {
    nodes: matchedNodes,
    edges: matchedEdges,
    description: `Search results for "${query}"`,
  };
}
