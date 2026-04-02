// =============================================================================
// backend-max — tRPC router analyzer
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import { type Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
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

/** Patterns that indicate tRPC router definitions. */
const TRPC_ROUTER_REGEX = /(?:router|createTRPCRouter)\s*\(\s*\{/;

/** Patterns for tRPC procedure definitions. */
const PROCEDURE_REGEX =
  /(\w+)\s*:\s*(?:publicProcedure|protectedProcedure|procedure|t\.procedure)\b/g;

/** Pattern for .input() calls (tRPC input validation). */
const INPUT_REGEX = /\.input\s*\(/;

/** Pattern for .query() calls. */
const _QUERY_REGEX = /\.query\s*\(/;

/** Pattern for .mutation() calls. */
const MUTATION_REGEX = /\.mutation\s*\(/;

/** Pattern for .subscription() calls. */
const SUBSCRIPTION_REGEX = /\.subscription\s*\(/;

/** Pattern for protected procedures. */
const PROTECTED_REGEX = /protectedProcedure|requireAuth|isAuthed|enforceAuth/;

// ---------------------------------------------------------------------------
// tRPC Analyzer
// ---------------------------------------------------------------------------

/**
 * Creates a tRPC framework analyzer implementing FrameworkAnalyzer.
 */
export function createTRPCAnalyzer(): FrameworkAnalyzer {
  return {
    name: "trpc",
    detect,
    scanRoutes: scanTRPCRoutes,
    getFrameworkChecks,
  };
}

/**
 * Detect if tRPC is used in the project by checking package.json.
 */
async function detect(projectPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    return (
      "@trpc/server" in deps ||
      "@trpc/server" in devDeps ||
      "@trpc/next" in deps ||
      "@trpc/next" in devDeps
    );
  } catch {
    /* skip: unreadable/unparseable package.json */
    return false;
  }
}

/**
 * Scan all tRPC routers in the project and map procedures to RouteInfo.
 */
async function scanTRPCRoutes(projectPath: string): Promise<RouteInfo[]> {
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

  // Find files containing tRPC router definitions
  const routerFiles: Array<{ filePath: string; content: string }> = [];

  for (const filePath of sourceFiles) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (TRPC_ROUTER_REGEX.test(content)) {
        routerFiles.push({ filePath, content });
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  if (routerFiles.length === 0) {
    return [];
  }

  const project = createProject(projectPath);
  const allRoutes: RouteInfo[] = [];

  for (const { filePath, content } of routerFiles) {
    try {
      const routes = analyzeTRPCFile(filePath, content, project);
      allRoutes.push(...routes);
    } catch {
      /* skip: unreadable/unparseable file */
    }
  }

  allRoutes.sort((a, b) => a.url.localeCompare(b.url));
  return allRoutes;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

/**
 * Analyzes a single tRPC router file for procedure definitions.
 */
function analyzeTRPCFile(filePath: string, content: string, project: Project): RouteInfo[] {
  let sourceFile: SourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(filePath);
  } catch {
    /* skip: unreadable/unparseable file */
    return [];
  }

  const routes: RouteInfo[] = [];

  // Find the router name from the variable declaration
  const routerName = extractRouterName(sourceFile) ?? "unknown";

  // Extract procedures using regex first (more reliable for tRPC's chained API)
  const procedures = extractProcedures(content, filePath);

  for (const proc of procedures) {
    const httpMethod = proc.type === "mutation" ? "POST" : "GET";
    const url = `/trpc/${routerName}.${proc.name}`;

    // Try to find the procedure node in the AST for deeper analysis
    const procNode = findProcedureNode(sourceFile, proc.name);

    const methodInfo: MethodInfo = {
      method: httpMethod,
      hasValidation: proc.hasInput || (procNode ? detectValidation(procNode) : false),
      hasErrorHandling: procNode ? detectErrorHandling(procNode) : /try\s*\{/.test(proc.bodyText),
      hasDatabaseCalls: procNode
        ? detectDatabaseCalls(procNode).length > 0
        : /prisma\.|db\.|knex|kysely|typeorm|sequelize|mongoose/i.test(proc.bodyText),
      hasAuth: proc.isProtected || (procNode ? detectAuthPatterns(procNode) : false),
      returnType: null,
      databaseCalls: procNode
        ? detectDatabaseCalls(procNode)
        : extractDbCallsFromText(proc.bodyText),
      lineNumber: proc.line,
    };

    routes.push({
      filePath,
      url,
      methods: [methodInfo],
      dynamicParams: [],
    });
  }

  return routes;
}

/**
 * Extracts the router variable name from the file.
 */
function extractRouterName(sourceFile: SourceFile): string | null {
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const text = init.getText();
      if (/(?:router|createTRPCRouter)\s*\(/.test(text)) {
        return decl.getName().replace(/Router$/, "");
      }
    }
  }

  // Try exported function-style router
  for (const func of sourceFile.getFunctions()) {
    if (func.isExported() && /router/i.test(func.getName() ?? "")) {
      return (func.getName() ?? "unknown").replace(/Router$/, "");
    }
  }

  return null;
}

/** Info about a single tRPC procedure extracted from source. */
interface ProcedureInfo {
  name: string;
  type: "query" | "mutation" | "subscription";
  hasInput: boolean;
  isProtected: boolean;
  bodyText: string;
  line: number;
}

/**
 * Extracts tRPC procedures from file content using regex analysis.
 */
function extractProcedures(content: string, _filePath: string): ProcedureInfo[] {
  const procedures: ProcedureInfo[] = [];
  const _lines = content.split("\n");

  PROCEDURE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PROCEDURE_REGEX.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index;
    const lineNumber = content.slice(0, startIdx).split("\n").length;

    // Get the text from the procedure definition to the next procedure or end of router
    const restOfContent = content.slice(startIdx);
    const bodyEnd = findProcedureEnd(restOfContent);
    const bodyText = restOfContent.slice(0, bodyEnd);

    const type: ProcedureInfo["type"] = MUTATION_REGEX.test(bodyText)
      ? "mutation"
      : SUBSCRIPTION_REGEX.test(bodyText)
        ? "subscription"
        : "query";

    procedures.push({
      name,
      type,
      hasInput: INPUT_REGEX.test(bodyText),
      isProtected: PROTECTED_REGEX.test(bodyText),
      bodyText,
      line: lineNumber,
    });
  }

  return procedures;
}

/**
 * Finds the approximate end of a procedure definition by tracking brackets.
 */
function findProcedureEnd(text: string): number {
  let depth = 0;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
      started = true;
    } else if (text[i] === ")") {
      depth--;
      if (started && depth === 0) {
        return i + 1;
      }
    }
    // Also check for next procedure pattern
    if (started && depth <= 1 && i > 50) {
      const remaining = text.slice(i);
      if (
        /^\s*\w+\s*:\s*(?:publicProcedure|protectedProcedure|procedure|t\.procedure)/.test(
          remaining,
        )
      ) {
        return i;
      }
    }
  }

  return Math.min(text.length, 2000);
}

/**
 * Finds a procedure's AST node by name.
 */
function findProcedureNode(sourceFile: SourceFile, procName: string): Node | null {
  const properties = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);

  for (const prop of properties) {
    if (prop.getName() === procName) {
      return prop;
    }
  }

  return null;
}

/**
 * Extracts database call strings from raw text (fallback).
 */
function extractDbCallsFromText(text: string): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();

  const prismaRegex = /prisma\.\w+\.\w+/g;
  const drizzleRegex = /db\.(select|insert|update|delete|query)\b/g;

  for (const regex of [prismaRegex, drizzleRegex]) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const normalized = m[0].trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        calls.push(normalized);
      }
    }
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Framework-specific checks
// ---------------------------------------------------------------------------

function getFrameworkChecks(): FrameworkCheck[] {
  return [
    {
      id: "trpc-unvalidated-mutation",
      name: "Mutation without input validation",
      description:
        "tRPC mutations that accept user input should use .input() with a Zod/Valibot schema for type-safe validation.",
      check: checkUnvalidatedMutations,
    },
    {
      id: "trpc-unprotected-mutation",
      name: "Unprotected mutation",
      description:
        "Mutations that modify data should use protectedProcedure or include auth checks.",
      check: checkUnprotectedMutations,
    },
    {
      id: "trpc-no-error-handling",
      name: "Procedure without error handling",
      description:
        "tRPC procedures with database calls should have error handling to return proper TRPCError responses.",
      check: checkMissingErrorHandling,
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
    if (!route.url.startsWith("/trpc/")) continue;

    for (const method of route.methods) {
      if (method.method === "POST" && !method.hasValidation) {
        issues.push({
          id: "",
          category: "validation",
          severity: "warning",
          title: `tRPC mutation without input validation: ${route.url}`,
          description:
            "This mutation does not use .input() with a schema. Add input validation to ensure type-safe data handling.",
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

async function checkUnprotectedMutations(
  _projectPath: string,
  routes: RouteInfo[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();

  for (const route of routes) {
    if (!route.url.startsWith("/trpc/")) continue;

    for (const method of route.methods) {
      if (method.method === "POST" && !method.hasAuth) {
        issues.push({
          id: "",
          category: "auth",
          severity: "warning",
          title: `Unprotected tRPC mutation: ${route.url}`,
          description:
            "This mutation uses publicProcedure. If it modifies user data, consider using protectedProcedure instead.",
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

async function checkMissingErrorHandling(
  _projectPath: string,
  routes: RouteInfo[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();

  for (const route of routes) {
    if (!route.url.startsWith("/trpc/")) continue;

    for (const method of route.methods) {
      if (method.hasDatabaseCalls && !method.hasErrorHandling) {
        issues.push({
          id: "",
          category: "error-handling",
          severity: "warning",
          title: `tRPC procedure without error handling: ${route.url}`,
          description:
            "This procedure makes database calls but has no try/catch. Wrap in try/catch and throw TRPCError for proper error responses.",
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
