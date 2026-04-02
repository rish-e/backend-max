// =============================================================================
// backend-max — Performance Auditor
//
// Detects performance anti-patterns: N+1 queries, unbounded database calls,
// missing pagination, and over-fetching (no select clause).
// =============================================================================

import { glob } from "glob";
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import { createProject } from "../analyzers/typescript.js";
import type { Issue, IssueCategory, Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROUTE_PATTERNS = [
  "app/**/route.{ts,tsx,js,jsx}",
  "src/app/**/route.{ts,tsx,js,jsx}",
  "pages/api/**/*.{ts,tsx,js,jsx}",
  "src/pages/api/**/*.{ts,tsx,js,jsx}",
];

const IGNORE_DIRS = ["node_modules/**", ".next/**", "dist/**", "build/**", ".git/**"];

/** Database call patterns (Prisma, Drizzle, Mongoose, Knex, etc.). */
const DB_CALL_PATTERNS = [
  /prisma\.\w+\.findMany/,
  /prisma\.\w+\.findFirst/,
  /prisma\.\w+\.findUnique/,
  /prisma\.\w+\.findUniqueOrThrow/,
  /prisma\.\w+\.findFirstOrThrow/,
  /prisma\.\w+\.create/,
  /prisma\.\w+\.update/,
  /prisma\.\w+\.delete/,
  /prisma\.\w+\.upsert/,
  /prisma\.\w+\.aggregate/,
  /prisma\.\w+\.groupBy/,
  /prisma\.\w+\.count/,
  /\.find\(/,
  /\.findOne\(/,
  /\.findById\(/,
  /\.aggregate\(/,
  /db\.\w+\.\w+/,
  /drizzle.*\.select/,
  /knex.*\.select/,
];

/** Patterns that indicate a findMany / list query. */
const LIST_QUERY_PATTERNS = [
  /\.findMany\(/,
  /\.find\(\s*\{?\s*\}/,
  /\.find\(\s*\)/,
  /\.aggregate\(/,
  /\.select\(\).*\.from\(/,
];

/** Patterns indicating pagination is present. */
const PAGINATION_PATTERNS = [
  /take\s*:/,
  /limit\s*:/,
  /\.limit\(/,
  /\.take\(/,
  /skip\s*:/,
  /offset\s*:/,
  /\.skip\(/,
  /\.offset\(/,
  /page\s*[=:]/,
  /pageSize\s*[=:]/,
  /perPage\s*[=:]/,
  /per_page\s*[=:]/,
  /cursor\s*:/,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit performance anti-patterns in backend route handlers.
 *
 * Detects:
 * 1. **N+1 queries** -- database calls inside loops.
 * 2. **Unbounded queries** -- `findMany` / `find` without `take` / `limit`.
 * 3. **Missing pagination** -- list endpoints without pagination parameters.
 * 4. **Over-fetching** -- Prisma queries without a `select` clause.
 *
 * @param projectPath Absolute path to the project root.
 * @returns Issues and a summary with counts per anti-pattern category.
 */
export async function auditPerformance(projectPath: string): Promise<{
  issues: Issue[];
  summary: {
    n1Queries: number;
    unboundedQueries: number;
    missingPagination: number;
  };
}> {
  const issues: Issue[] = [];
  let n1Count = 0;
  let unboundedCount = 0;
  let paginationCount = 0;

  try {
    // Discover route files.
    const routeFiles = await discoverRouteFiles(projectPath);

    if (routeFiles.length === 0) {
      return {
        issues: [],
        summary: {
          n1Queries: 0,
          unboundedQueries: 0,
          missingPagination: 0,
        },
      };
    }

    // Parse with ts-morph.
    const project = createProject(projectPath);
    for (const file of routeFiles) {
      project.addSourceFileAtPath(file);
    }

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      const relPath = filePath.replace(projectPath, "").replace(/^\//, "");

      // ------------------------------------------------------------------
      // 1. N+1 query detection
      // ------------------------------------------------------------------
      const n1Issues = detectN1Queries(sourceFile, filePath, relPath);
      for (const issue of n1Issues) {
        issues.push(issue);
        n1Count++;
      }

      // ------------------------------------------------------------------
      // 2. Unbounded queries
      // ------------------------------------------------------------------
      const unboundedIssues = detectUnboundedQueries(sourceFile, filePath, relPath);
      for (const issue of unboundedIssues) {
        issues.push(issue);
        unboundedCount++;
      }

      // ------------------------------------------------------------------
      // 3. Missing pagination on GET list endpoints
      // ------------------------------------------------------------------
      const paginationIssues = detectMissingPagination(sourceFile, filePath, relPath);
      for (const issue of paginationIssues) {
        issues.push(issue);
        paginationCount++;
      }

      // ------------------------------------------------------------------
      // 4. Over-fetching (no select clause)
      // ------------------------------------------------------------------
      const overFetchIssues = detectOverFetching(sourceFile, filePath, relPath);
      issues.push(...overFetchIssues);
    }

    return {
      issues,
      summary: {
        n1Queries: n1Count,
        unboundedQueries: unboundedCount,
        missingPagination: paginationCount,
      },
    };
  } catch (error) {
    return {
      issues: [
        makeIssue(
          "PERF-INTERNAL-1",
          "performance",
          "warning",
          "Performance auditor encountered an internal error",
          `The performance auditor failed: ${error instanceof Error ? error.message : String(error)}`,
          projectPath,
          null,
        ),
      ],
      summary: {
        n1Queries: n1Count,
        unboundedQueries: unboundedCount,
        missingPagination: paginationCount,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// N+1 query detection
// ---------------------------------------------------------------------------

/**
 * Find database calls that occur inside loops (for, for-of, for-in,
 * forEach, map with await). This is the classic N+1 pattern.
 */
function detectN1Queries(sourceFile: SourceFile, filePath: string, relPath: string): Issue[] {
  const issues: Issue[] = [];

  // Find all loop-like constructs.
  const loops = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ForStatement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ForOfStatement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ForInStatement),
  ];

  for (const loop of loops) {
    const loopText = loop.getText();
    const dbCalls = findDbCallsInText(loopText);
    if (dbCalls.length > 0) {
      issues.push(
        makeIssue(
          `PERF-N1-${issues.length + 1}`,
          "performance",
          "critical",
          `N+1 query in loop: ${relPath}`,
          `Database call "${dbCalls[0]}" found inside a loop in ${relPath}. This causes N+1 queries which degrade performance linearly with data size. Refactor to batch the query outside the loop.`,
          filePath,
          loop.getStartLineNumber(),
        ),
      );
    }
  }

  // Also check forEach / map / flatMap callbacks with await inside.
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;

    const methodName = expr.getName();
    if (!["forEach", "map", "flatMap"].includes(methodName)) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const callback = args[0];
    const callbackText = callback.getText();

    // Check if the callback contains await + db call.
    if (/await\s/.test(callbackText)) {
      const dbCalls = findDbCallsInText(callbackText);
      if (dbCalls.length > 0) {
        issues.push(
          makeIssue(
            `PERF-N1-${issues.length + 1}`,
            "performance",
            "critical",
            `N+1 query in ${methodName} callback: ${relPath}`,
            `Database call "${dbCalls[0]}" found inside an async ${methodName} callback in ${relPath}. Each iteration triggers a separate query. Use a batch operation instead.`,
            filePath,
            call.getStartLineNumber(),
          ),
        );
      }
    }
  }

  return issues;
}

function findDbCallsInText(text: string): string[] {
  const found: string[] = [];
  for (const pattern of DB_CALL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      found.push(match[0]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Unbounded query detection
// ---------------------------------------------------------------------------

/**
 * Find findMany / find calls that don't include a take/limit parameter.
 */
function detectUnboundedQueries(
  sourceFile: SourceFile,
  filePath: string,
  relPath: string,
): Issue[] {
  const issues: Issue[] = [];
  const text = sourceFile.getText();

  // Find all findMany-like calls.
  const findManyRegex = /(?:prisma\.\w+\.findMany|\.find)\s*\(([^)]*)\)/gs;

  let match: RegExpExecArray | null;
  while ((match = findManyRegex.exec(text)) !== null) {
    const args = match[1];

    // Check if args contain take, limit, or cursor.
    const hasBound = PAGINATION_PATTERNS.some((p) => p.test(args));

    if (!hasBound) {
      // Compute line number.
      const lineNum = text.slice(0, match.index).split("\n").length;

      issues.push(
        makeIssue(
          `PERF-UB-${issues.length + 1}`,
          "performance",
          "warning",
          `Unbounded query: ${relPath}`,
          `Query "${match[0].slice(0, 60)}..." in ${relPath} has no take/limit. Large tables will return all rows, causing memory issues and slow responses. Add a limit.`,
          filePath,
          lineNum,
        ),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Missing pagination detection
// ---------------------------------------------------------------------------

/**
 * Check if GET handlers that return arrays have pagination support.
 */
function detectMissingPagination(
  sourceFile: SourceFile,
  filePath: string,
  relPath: string,
): Issue[] {
  const issues: Issue[] = [];

  // Find exported GET handlers.
  const getHandlers = findExportedHandlers(sourceFile, "GET");

  for (const handler of getHandlers) {
    const body = Node.isArrowFunction(handler) ? handler.getBody() : handler.getBody();

    if (!body) continue;

    const bodyText = body.getText();

    // Check if this handler contains list queries.
    const hasList = LIST_QUERY_PATTERNS.some((p) => p.test(bodyText));
    if (!hasList) continue;

    // Check if pagination params are referenced.
    const hasPagination = PAGINATION_PATTERNS.some((p) => p.test(bodyText));
    if (hasPagination) continue;

    // Also check if search params are accessed for page/limit.
    const usesSearchParams =
      /searchParams/.test(bodyText) && (/page/.test(bodyText) || /limit/.test(bodyText));
    if (usesSearchParams) continue;

    issues.push(
      makeIssue(
        `PERF-PG-${issues.length + 1}`,
        "performance",
        "info",
        `Missing pagination: ${relPath}`,
        `GET handler in ${relPath} returns list data but does not implement pagination. As data grows, this endpoint will become slow. Add page/limit or cursor-based pagination.`,
        filePath,
        handler.getStartLineNumber(),
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Over-fetching detection
// ---------------------------------------------------------------------------

/**
 * Detect Prisma queries that fetch all fields (no `select` clause).
 */
function detectOverFetching(sourceFile: SourceFile, filePath: string, relPath: string): Issue[] {
  const issues: Issue[] = [];
  const text = sourceFile.getText();

  // Match prisma calls that are findMany, findFirst, findUnique.
  const prismaQueryRegex =
    /prisma\.\w+\.(?:findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow)\s*\((\{[^}]*\})\)/gs;

  let match: RegExpExecArray | null;
  while ((match = prismaQueryRegex.exec(text)) !== null) {
    const queryArgs = match[1];

    // Check if select or include is specified.
    if (/select\s*:/.test(queryArgs)) continue;
    if (/include\s*:/.test(queryArgs)) continue;

    const lineNum = text.slice(0, match.index).split("\n").length;

    issues.push(
      makeIssue(
        `PERF-OF-${issues.length + 1}`,
        "performance",
        "info",
        `No select clause: ${relPath}`,
        `Prisma query "${match[0].slice(0, 50)}..." in ${relPath} fetches all columns. Use a \`select\` clause to fetch only the fields the frontend needs, reducing payload size and database load.`,
        filePath,
        lineNum,
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

type HandlerNode =
  | import("ts-morph").FunctionDeclaration
  | import("ts-morph").FunctionExpression
  | import("ts-morph").ArrowFunction;

/**
 * Find exported handlers for a given HTTP method name.
 */
function findExportedHandlers(sourceFile: SourceFile, methodName: string): HandlerNode[] {
  const handlers: HandlerNode[] = [];

  // Named function exports: export async function GET(...)
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isExported() && fn.getName() === methodName) {
      handlers.push(fn);
    }
  }

  // Variable exports: export const GET = async (req) => { ... }
  for (const varStmt of sourceFile.getVariableStatements()) {
    if (!varStmt.isExported()) continue;
    for (const decl of varStmt.getDeclarations()) {
      if (decl.getName() !== methodName) continue;
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        handlers.push(init);
      }
    }
  }

  return handlers;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function discoverRouteFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of ROUTE_PATTERNS) {
    const matches = await glob(pattern, {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: IGNORE_DIRS,
    });
    files.push(...matches);
  }
  return [...new Set(files)];
}

// ---------------------------------------------------------------------------
// Issue factory
// ---------------------------------------------------------------------------

function makeIssue(
  id: string,
  category: IssueCategory,
  severity: Severity,
  title: string,
  description: string,
  file: string,
  line: number | null,
): Issue {
  return {
    id,
    category,
    severity,
    title,
    description,
    file,
    line,
    status: "open",
    firstSeen: new Date().toISOString(),
    fixedAt: null,
  };
}
