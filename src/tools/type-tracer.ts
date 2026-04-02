// =============================================================================
// backend-max — Multi-layer type tracing (frontend → route → service → DB)
// =============================================================================

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "glob";
import type { Issue, RouteInfo } from "../types.js";
import { getTimestamp } from "../utils/helpers.js";
import { scanRoutes } from "./route-scanner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single link in the type chain. */
export interface TypeLink {
  /** Layer name. */
  layer: "frontend" | "route" | "service" | "repository" | "database";
  /** File where this link was found. */
  file: string;
  /** Line number. */
  line: number | null;
  /** Type name or shape description. */
  typeName: string;
  /** Properties accessed or defined at this layer. */
  properties: string[];
}

/** A full type trace from frontend to database. */
export interface TypeTrace {
  /** The API endpoint this trace is for. */
  endpoint: string;
  /** HTTP method. */
  method: string;
  /** Ordered list of type links from frontend to DB. */
  chain: TypeLink[];
  /** Mismatches found between layers. */
  mismatches: TypeMismatch[];
}

/** A mismatch between two layers in the type chain. */
export interface TypeMismatch {
  /** Source layer. */
  from: TypeLink["layer"];
  /** Target layer. */
  to: TypeLink["layer"];
  /** Description of the mismatch. */
  description: string;
  /** Properties that don't match. */
  properties: string[];
}

/** Result of multi-layer type tracing. */
export interface TypeTraceResult {
  issues: Issue[];
  traces: TypeTrace[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Patterns for detecting layers
// ---------------------------------------------------------------------------

/** Patterns that indicate service/business logic layer files. */
const SERVICE_PATTERNS = [/service/i, /usecase/i, /interactor/i, /handler/i, /controller/i];

/** Patterns that indicate repository/data-access layer files. */
const REPO_PATTERNS = [/repository/i, /repo\b/i, /dal\b/i, /data-access/i, /store/i];

/** Patterns for extracting type definitions. */
const TYPE_DEF_REGEX = /(?:type|interface)\s+(\w+)\s*(?:=\s*)?{([^}]*)}/g;

/** Patterns for function return type annotations. */
const _RETURN_TYPE_REGEX = /(?:Promise<|:\s*)(\w+)(?:[>\s]|$)/;

/** Patterns for property access in frontend code. */
const PROPERTY_ACCESS_REGEX = /(?:data|result|response|res|body)\.(\w+(?:\.\w+)*)/g;

/** Patterns for object destructuring. */
const DESTRUCTURE_REGEX =
  /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:data|result|response|res|body)/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Traces types across application layers: frontend → route → service → DB.
 * Identifies mismatches where types diverge between layers.
 */
export async function traceTypes(projectPath: string): Promise<TypeTraceResult> {
  const timestamp = getTimestamp();
  const issues: Issue[] = [];
  const traces: TypeTrace[] = [];

  // 1. Scan routes to get the API surface
  let routes: RouteInfo[] = [];
  try {
    const scanResult = await scanRoutes(projectPath);
    routes = scanResult.routes;
  } catch {
    return {
      issues: [],
      traces: [],
      summary: "Could not scan routes for type tracing.",
    };
  }

  if (routes.length === 0) {
    return {
      issues: [],
      traces: [],
      summary: "No routes found for type tracing.",
    };
  }

  // 2. Categorize source files by layer
  const layers = await categorizeFiles(projectPath);

  // 3. For each route, build a type trace
  for (const route of routes) {
    for (const method of route.methods) {
      const trace = await buildTypeTrace(projectPath, route, method.method, layers);

      if (trace.chain.length > 1) {
        traces.push(trace);

        // Generate issues from mismatches
        for (const mismatch of trace.mismatches) {
          issues.push({
            id: "",
            category: "contract-type-mismatch",
            severity: "warning",
            title: `Type mismatch between ${mismatch.from} and ${mismatch.to}: ${method.method} ${route.url}`,
            description: mismatch.description,
            file: route.filePath,
            line: null,
            status: "open",
            firstSeen: timestamp,
            fixedAt: null,
          });
        }
      }
    }
  }

  // 4. Check for missing layers (common anti-patterns)
  const routesWithDirectDB = traces.filter((t) => {
    const layers = t.chain.map((c) => c.layer);
    return layers.includes("route") && layers.includes("database") && !layers.includes("service");
  });

  if (routesWithDirectDB.length > 3) {
    issues.push({
      id: "",
      category: "performance",
      severity: "info",
      title: `${routesWithDirectDB.length} routes access DB directly without service layer`,
      description:
        "These route handlers call the database directly without going through a service/business logic layer. " +
        "Consider extracting DB operations into service files for better testability and separation of concerns.",
      file: routesWithDirectDB[0].chain[0]?.file ?? join(projectPath, "package.json"),
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  const summary = [
    `${traces.length} type trace(s) built.`,
    `${issues.length} type mismatch(es) found.`,
    `Layers detected: ${describeLayerCoverage(layers)}.`,
  ].join(" ");

  return { issues, traces, summary };
}

// ---------------------------------------------------------------------------
// File categorization
// ---------------------------------------------------------------------------

interface LayerFiles {
  frontend: string[];
  service: string[];
  repository: string[];
}

async function categorizeFiles(projectPath: string): Promise<LayerFiles> {
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

  const layers: LayerFiles = {
    frontend: [],
    service: [],
    repository: [],
  };

  for (const filePath of sourceFiles) {
    const rel = relative(projectPath, filePath).toLowerCase();

    // Frontend: components, pages (non-api), app (non-api), hooks, lib with fetch
    if (
      /^(components|app(?!.*api)|pages(?!.*api)|hooks|lib|src\/components|src\/hooks|src\/lib)/.test(
        rel,
      ) &&
      !SERVICE_PATTERNS.some((p) => p.test(rel)) &&
      !REPO_PATTERNS.some((p) => p.test(rel))
    ) {
      layers.frontend.push(filePath);
    }

    // Service layer
    if (SERVICE_PATTERNS.some((p) => p.test(rel))) {
      layers.service.push(filePath);
    }

    // Repository layer
    if (REPO_PATTERNS.some((p) => p.test(rel))) {
      layers.repository.push(filePath);
    }
  }

  return layers;
}

function describeLayerCoverage(layers: LayerFiles): string {
  const parts: string[] = [];
  if (layers.frontend.length > 0) parts.push(`${layers.frontend.length} frontend`);
  if (layers.service.length > 0) parts.push(`${layers.service.length} service`);
  if (layers.repository.length > 0) parts.push(`${layers.repository.length} repository`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

// ---------------------------------------------------------------------------
// Type trace builder
// ---------------------------------------------------------------------------

async function buildTypeTrace(
  projectPath: string,
  route: RouteInfo,
  method: string,
  layers: LayerFiles,
): Promise<TypeTrace> {
  const chain: TypeLink[] = [];
  const mismatches: TypeMismatch[] = [];

  // 1. Route layer — extract types from the route handler
  const routeTypes = await extractRouteTypes(route.filePath, route.url);
  if (routeTypes) {
    chain.push(routeTypes);
  }

  // 2. Check if the route handler calls into service files
  const routeContent = await safeReadFile(route.filePath);
  if (routeContent) {
    // Find imports from service layer
    for (const serviceFile of layers.service) {
      const rel = relative(projectPath, serviceFile).replace(/\.\w+$/, "");
      if (routeContent.includes(rel) || routeContent.includes(rel.replace(/\\/g, "/"))) {
        const serviceTypes = await extractServiceTypes(serviceFile);
        if (serviceTypes) {
          chain.push(serviceTypes);
        }
      }
    }

    // Find imports from repository layer
    for (const repoFile of layers.repository) {
      const rel = relative(projectPath, repoFile).replace(/\.\w+$/, "");
      if (routeContent.includes(rel) || routeContent.includes(rel.replace(/\\/g, "/"))) {
        const repoTypes = await extractRepoTypes(repoFile);
        if (repoTypes) {
          chain.push(repoTypes);
        }
      }
    }

    // Check for direct database calls (Prisma/Drizzle)
    if (route.methods.some((m) => m.hasDatabaseCalls)) {
      const dbProps = extractDBProperties(routeContent);
      if (dbProps.length > 0) {
        chain.push({
          layer: "database",
          file: route.filePath,
          line: null,
          typeName: "database-query",
          properties: dbProps,
        });
      }
    }
  }

  // 3. Find frontend calls to this route and extract expected types
  for (const frontendFile of layers.frontend.slice(0, 200)) {
    const frontendContent = await safeReadFile(frontendFile);
    if (!frontendContent) continue;

    // Check if this frontend file references this route
    const urlPattern = route.url.replace(/\[(\w+)\]/g, "").replace(/\/+$/, "");
    if (!frontendContent.includes(urlPattern) && !frontendContent.includes(route.url)) continue;

    const frontendTypes = extractFrontendTypes(frontendContent, frontendFile, route.url);
    if (frontendTypes && frontendTypes.properties.length > 0) {
      chain.unshift(frontendTypes); // Frontend goes first in the chain
    }
  }

  // 4. Detect mismatches between adjacent layers
  for (let i = 0; i < chain.length - 1; i++) {
    const current = chain[i];
    const next = chain[i + 1];

    // Check for property mismatches between layers
    if (current.properties.length > 0 && next.properties.length > 0) {
      const _currentProps = new Set(current.properties.map((p) => p.toLowerCase()));
      const nextProps = new Set(next.properties.map((p) => p.toLowerCase()));

      const missingInNext: string[] = [];
      for (const prop of current.properties) {
        if (!nextProps.has(prop.toLowerCase())) {
          // Check for common naming convention differences
          const camelCase = prop.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
          const snakeCase = prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
          if (!nextProps.has(camelCase.toLowerCase()) && !nextProps.has(snakeCase.toLowerCase())) {
            missingInNext.push(prop);
          }
        }
      }

      if (missingInNext.length > 0) {
        mismatches.push({
          from: current.layer,
          to: next.layer,
          description:
            `Properties [${missingInNext.join(", ")}] expected by ${current.layer} layer ` +
            `but not found in ${next.layer} layer.`,
          properties: missingInNext,
        });
      }
    }
  }

  return {
    endpoint: route.url,
    method,
    chain,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Per-layer type extraction
// ---------------------------------------------------------------------------

async function extractRouteTypes(filePath: string, _url: string): Promise<TypeLink | null> {
  const content = await safeReadFile(filePath);
  if (!content) return null;

  const properties: string[] = [];

  // Extract from response JSON construction: json({ user, posts })
  const jsonResponse = content.match(/json\s*\(\s*\{([^}]+)\}/);
  if (jsonResponse) {
    const props = jsonResponse[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  // Extract from NextResponse.json({ ... })
  const nextResponse = content.match(/NextResponse\.json\s*\(\s*\{([^}]+)\}/);
  if (nextResponse) {
    const props = nextResponse[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  // Extract from return statements: return { user, ... }
  const returnObj = content.match(/return\s*\{([^}]+)\}/);
  if (returnObj && !/import|require/.test(returnObj[0])) {
    const props = returnObj[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  // Extract type annotations from the handler
  TYPE_DEF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TYPE_DEF_REGEX.exec(content)) !== null) {
    if (/response|result|output/i.test(match[1])) {
      const typeProps = match[2]
        .split(/[;\n]/)
        .map((p) => p.trim().split(/[?:]/)[0].trim())
        .filter(Boolean);
      properties.push(...typeProps);
    }
  }

  if (properties.length === 0) return null;

  return {
    layer: "route",
    file: filePath,
    line: null,
    typeName: "route-handler",
    properties: [...new Set(properties)],
  };
}

async function extractServiceTypes(filePath: string): Promise<TypeLink | null> {
  const content = await safeReadFile(filePath);
  if (!content) return null;

  const properties: string[] = [];

  // Extract exported function return types
  TYPE_DEF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TYPE_DEF_REGEX.exec(content)) !== null) {
    const typeProps = match[2]
      .split(/[;\n]/)
      .map((p) => p.trim().split(/[?:]/)[0].trim())
      .filter(Boolean);
    properties.push(...typeProps);
  }

  // Extract from return statements in exported functions
  const returns = content.matchAll(/return\s*\{([^}]+)\}/g);
  for (const ret of returns) {
    const props = ret[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  if (properties.length === 0) return null;

  return {
    layer: "service",
    file: filePath,
    line: null,
    typeName: "service",
    properties: [...new Set(properties)],
  };
}

async function extractRepoTypes(filePath: string): Promise<TypeLink | null> {
  const content = await safeReadFile(filePath);
  if (!content) return null;

  const properties: string[] = [];

  // Extract select/include fields from Prisma/Drizzle queries
  const selectMatch = content.match(/select\s*:\s*\{([^}]+)\}/);
  if (selectMatch) {
    const props = selectMatch[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  // Extract from type definitions
  TYPE_DEF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TYPE_DEF_REGEX.exec(content)) !== null) {
    const typeProps = match[2]
      .split(/[;\n]/)
      .map((p) => p.trim().split(/[?:]/)[0].trim())
      .filter(Boolean);
    properties.push(...typeProps);
  }

  if (properties.length === 0) return null;

  return {
    layer: "repository",
    file: filePath,
    line: null,
    typeName: "repository",
    properties: [...new Set(properties)],
  };
}

function extractFrontendTypes(
  content: string,
  filePath: string,
  _routeUrl: string,
): TypeLink | null {
  const properties: string[] = [];

  // Extract property access patterns: data.user, response.items, etc.
  PROPERTY_ACCESS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROPERTY_ACCESS_REGEX.exec(content)) !== null) {
    properties.push(...match[1].split("."));
  }

  // Extract destructuring: const { user, posts } = await data
  DESTRUCTURE_REGEX.lastIndex = 0;
  while ((match = DESTRUCTURE_REGEX.exec(content)) !== null) {
    const props = match[1]
      .split(",")
      .map((p) => {
        const trimmed = p.trim();
        // Handle renaming: originalName: newName
        return trimmed.split(":")[0].trim();
      })
      .filter(Boolean);
    properties.push(...props);
  }

  if (properties.length === 0) return null;

  return {
    layer: "frontend",
    file: filePath,
    line: null,
    typeName: "frontend-consumer",
    properties: [...new Set(properties)],
  };
}

function extractDBProperties(content: string): string[] {
  const properties: string[] = [];

  // Prisma select fields
  const selectMatches = content.matchAll(/select\s*:\s*\{([^}]+)\}/g);
  for (const match of selectMatches) {
    const props = match[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  // Prisma include fields
  const includeMatches = content.matchAll(/include\s*:\s*\{([^}]+)\}/g);
  for (const match of includeMatches) {
    const props = match[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  // Drizzle select fields
  const drizzleSelect = content.matchAll(/\.select\s*\(\s*\{([^}]+)\}/g);
  for (const match of drizzleSelect) {
    const props = match[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean);
    properties.push(...props);
  }

  return [...new Set(properties)];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    /* skip: unreadable file */
    return null;
  }
}
