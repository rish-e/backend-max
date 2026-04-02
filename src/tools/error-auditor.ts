// =============================================================================
// backend-max — Error Handling Auditor
//
// Uses ts-morph AST analysis to verify that every exported HTTP handler has
// proper error handling: try/catch, consistent error response shapes, and no
// unhandled promise chains.
// =============================================================================

import { glob } from "glob";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { createProject } from "../analyzers/typescript.js";
import type { Issue, IssueCategory, Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

const ROUTE_FILE_PATTERNS = [
  "app/**/route.ts",
  "app/**/route.tsx",
  "app/**/route.js",
  "app/**/route.jsx",
  "src/app/**/route.ts",
  "src/app/**/route.tsx",
  "src/app/**/route.js",
  "src/app/**/route.jsx",
  "pages/api/**/*.ts",
  "pages/api/**/*.tsx",
  "pages/api/**/*.js",
  "pages/api/**/*.jsx",
  "src/pages/api/**/*.ts",
  "src/pages/api/**/*.tsx",
  "src/pages/api/**/*.js",
  "src/pages/api/**/*.jsx",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorResponseShape {
  /** Stringified representation of the response shape for comparison. */
  shape: string;
  /** File where this shape was found. */
  file: string;
  /** Line number. */
  line: number;
}

type HandlerNode = FunctionDeclaration | FunctionExpression | ArrowFunction;

interface HandlerInfo {
  name: string;
  file: string;
  line: number;
  node: HandlerNode;
  hasTryCatch: boolean;
  hasSpecificCatch: boolean;
  catchReturnsResponse: boolean;
  unhandledPromiseChains: number;
  errorResponseShape: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit error handling across all API route handlers.
 *
 * Checks every exported HTTP handler for:
 * - `try/catch` coverage
 * - Specific vs generic `catch` clauses
 * - Whether catch blocks return proper error responses
 * - Consistent error response formats across routes
 * - Unhandled promise chains (`.then` without `.catch`)
 *
 * @param projectPath Absolute path to the project root.
 * @returns Issues found and a summary of handler coverage.
 */
export async function auditErrorHandling(projectPath: string): Promise<{
  issues: Issue[];
  summary: {
    totalHandlers: number;
    withErrorHandling: number;
    consistentFormat: boolean;
  };
}> {
  const issues: Issue[] = [];
  const handlers: HandlerInfo[] = [];

  try {
    // Discover route files.
    const routeFiles: string[] = [];
    for (const pattern of ROUTE_FILE_PATTERNS) {
      const matches = await glob(pattern, {
        cwd: projectPath,
        absolute: true,
        nodir: true,
      });
      routeFiles.push(...matches);
    }

    if (routeFiles.length === 0) {
      return {
        issues: [],
        summary: {
          totalHandlers: 0,
          withErrorHandling: 0,
          consistentFormat: true,
        },
      };
    }

    // Parse with ts-morph.
    const project = createProject(projectPath);
    for (const file of routeFiles) {
      project.addSourceFileAtPath(file);
    }

    // Analyse each source file.
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      const fileHandlers = extractHandlers(sourceFile);

      for (const handler of fileHandlers) {
        const info = analyseHandler(handler.node, handler.name, filePath);
        handlers.push(info);
      }
    }

    // Generate issues.
    const errorResponseShapes: ErrorResponseShape[] = [];

    for (const handler of handlers) {
      const relFile = handler.file;

      // Missing try/catch.
      if (!handler.hasTryCatch) {
        issues.push(
          makeIssue(
            `ERR-TC-${issues.length + 1}`,
            "error-handling",
            "warning",
            `Missing try/catch in ${handler.name}`,
            `Handler "${handler.name}" in ${relFile} does not wrap its logic in a try/catch block. Unhandled errors will crash the request.`,
            handler.file,
            handler.line,
          ),
        );
      }

      // Catch block that doesn't return a response.
      if (handler.hasTryCatch && !handler.catchReturnsResponse) {
        issues.push(
          makeIssue(
            `ERR-CR-${issues.length + 1}`,
            "error-handling",
            "critical",
            `Catch block without response in ${handler.name}`,
            `Handler "${handler.name}" in ${relFile} has a catch block that does not return an error response. The client will hang or receive an unexpected result.`,
            handler.file,
            handler.line,
          ),
        );
      }

      // Unhandled promise chains.
      if (handler.unhandledPromiseChains > 0) {
        issues.push(
          makeIssue(
            `ERR-UP-${issues.length + 1}`,
            "error-handling",
            "warning",
            `Unhandled promise chain in ${handler.name}`,
            `Handler "${handler.name}" in ${relFile} has ${handler.unhandledPromiseChains} .then() call(s) without a corresponding .catch(). Promise rejections will be unhandled.`,
            handler.file,
            handler.line,
          ),
        );
      }

      // Collect error response shapes for consistency check.
      if (handler.errorResponseShape) {
        errorResponseShapes.push({
          shape: handler.errorResponseShape,
          file: handler.file,
          line: handler.line,
        });
      }
    }

    // Check error response consistency.
    const consistentFormat = checkResponseConsistency(errorResponseShapes, issues);

    const withErrorHandling = handlers.filter((h) => h.hasTryCatch).length;

    return {
      issues,
      summary: {
        totalHandlers: handlers.length,
        withErrorHandling,
        consistentFormat,
      },
    };
  } catch (error) {
    // Graceful failure: return what we have so far.
    return {
      issues: [
        makeIssue(
          "ERR-INTERNAL-1",
          "error-handling",
          "warning",
          "Error auditor encountered an internal error",
          `The error auditor failed to complete: ${error instanceof Error ? error.message : String(error)}`,
          projectPath,
          null,
        ),
      ],
      summary: {
        totalHandlers: handlers.length,
        withErrorHandling: handlers.filter((h) => h.hasTryCatch).length,
        consistentFormat: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// AST analysis helpers
// ---------------------------------------------------------------------------

/**
 * Extract exported HTTP handler functions from a source file.
 * Handles both `export async function GET(...)` and
 * `export const GET = async (...)` patterns.
 */
function extractHandlers(sourceFile: SourceFile): { name: string; node: HandlerNode }[] {
  const results: { name: string; node: HandlerNode }[] = [];

  // Named function exports: export async function GET(...)
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (name && HTTP_METHODS.has(name)) {
      results.push({ name, node: fn });
    }
  }

  // Variable exports: export const GET = async (req) => { ... }
  for (const varStmt of sourceFile.getVariableStatements()) {
    if (!varStmt.isExported()) continue;
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      if (!HTTP_METHODS.has(name)) continue;

      const init = decl.getInitializer();
      if (!init) continue;

      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        results.push({ name, node: init });
      }
    }
  }

  // Default export for Pages API routes: export default function handler(...)
  const defaultExport = sourceFile.getDefaultExportSymbol();
  if (defaultExport) {
    const decls = defaultExport.getDeclarations();
    for (const decl of decls) {
      if (Node.isFunctionDeclaration(decl)) {
        results.push({ name: decl.getName() ?? "default", node: decl });
      }
    }
  }

  return results;
}

/**
 * Analyse a single handler node for error handling patterns.
 */
function analyseHandler(node: HandlerNode, name: string, filePath: string): HandlerInfo {
  const line = node.getStartLineNumber();
  const body = Node.isArrowFunction(node) ? node.getBody() : node.getBody();

  const info: HandlerInfo = {
    name,
    file: filePath,
    line,
    node,
    hasTryCatch: false,
    hasSpecificCatch: false,
    catchReturnsResponse: false,
    unhandledPromiseChains: 0,
    errorResponseShape: null,
  };

  if (!body) return info;

  // Check for try/catch statements.
  const tryStatements = body.getDescendantsOfKind(SyntaxKind.TryStatement);
  info.hasTryCatch = tryStatements.length > 0;

  if (info.hasTryCatch) {
    for (const tryStat of tryStatements) {
      const catchClause = tryStat.getCatchClause();
      if (!catchClause) continue;

      // Check if catch uses a specific error type (e.g., `catch (e: SomeError)`)
      // or checks instanceof within the catch body.
      const catchBody = catchClause.getBlock().getText();
      if (
        catchBody.includes("instanceof") ||
        catchBody.includes(".code") ||
        catchBody.includes(".status")
      ) {
        info.hasSpecificCatch = true;
      }

      // Check if the catch block returns a response.
      info.catchReturnsResponse = catchBlockReturnsResponse(catchClause);

      // Extract error response shape from catch block.
      info.errorResponseShape = extractErrorResponseShape(catchClause);
    }
  }

  // Check for unhandled promise chains (.then without .catch).
  info.unhandledPromiseChains = countUnhandledPromiseChains(body);

  return info;
}

/**
 * Determine whether a catch clause returns an HTTP response (NextResponse,
 * Response, res.status, etc.).
 */
function catchBlockReturnsResponse(catchClause: Node): boolean {
  const text = catchClause.getText();
  return (
    text.includes("NextResponse") ||
    text.includes("new Response") ||
    text.includes("Response.json") ||
    text.includes("res.status") ||
    text.includes("res.json") ||
    text.includes("json(") ||
    /return\s+.*\bResponse\b/.test(text)
  );
}

/**
 * Extract a simplified representation of the error response shape from a
 * catch clause for consistency comparison. Returns null if no response shape
 * is detectable.
 */
function extractErrorResponseShape(catchClause: Node): string | null {
  const text = catchClause.getText();

  // Look for JSON response patterns like: { error: ..., message: ... }
  // NextResponse.json({ error: ... }, { status: ... })
  // Response.json({ error: ... })
  const jsonMatch = text.match(/(?:NextResponse|Response)\.json\s*\(\s*(\{[^}]*\})/);
  if (jsonMatch) {
    // Extract the key names to compare shapes.
    const keys = jsonMatch[1].match(/(\w+)\s*:/g);
    return keys ? keys.sort().join(",") : "unknown";
  }

  // res.status(...).json({ ... })
  const resMatch = text.match(/\.json\s*\(\s*(\{[^}]*\})/);
  if (resMatch) {
    const keys = resMatch[1].match(/(\w+)\s*:/g);
    return keys ? keys.sort().join(",") : "unknown";
  }

  return null;
}

/**
 * Count `.then()` calls that are NOT followed by a `.catch()` in the same
 * chain.
 */
function countUnhandledPromiseChains(body: Node): number {
  let count = 0;
  const callExpressions = body.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const propAccess = call.getExpression();
    if (!Node.isPropertyAccessExpression(propAccess)) continue;

    if (propAccess.getName() === "then") {
      // Walk up the AST to see if a .catch follows in the same chain.
      const parent = call.getParent();
      let hasCatch = false;

      if (parent && Node.isPropertyAccessExpression(parent)) {
        if (parent.getName() === "catch") hasCatch = true;
      }

      // Also check the broader chain: look for .catch anywhere on the
      // same statement.
      const statement = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
      if (statement?.getText().includes(".catch(")) {
        hasCatch = true;
      }

      if (!hasCatch) count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Check whether all error responses use a consistent shape. If not, generate
 * warning issues.
 */
function checkResponseConsistency(shapes: ErrorResponseShape[], issues: Issue[]): boolean {
  if (shapes.length <= 1) return true;

  const uniqueShapes = new Map<string, ErrorResponseShape[]>();
  for (const s of shapes) {
    const existing = uniqueShapes.get(s.shape) ?? [];
    existing.push(s);
    uniqueShapes.set(s.shape, existing);
  }

  if (uniqueShapes.size <= 1) return true;

  // Multiple distinct shapes detected.
  const shapeList = [...uniqueShapes.entries()]
    .map(
      ([shape, occurrences]) =>
        `  Shape "${shape}" in ${occurrences.length} handler(s): ${occurrences.map((o) => o.file).join(", ")}`,
    )
    .join("\n");

  issues.push(
    makeIssue(
      `ERR-IC-${issues.length + 1}`,
      "error-handling",
      "warning",
      "Inconsistent error response formats",
      `Multiple error response shapes detected across handlers:\n${shapeList}\nStandardise on a single error response format for a consistent API experience.`,
      shapes[0].file,
      shapes[0].line,
    ),
  );

  return false;
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
