// =============================================================================
// backend-max — Frontend API call detection
// =============================================================================

import { glob } from "glob";
import { Node, type Project, SyntaxKind } from "ts-morph";
import type { FrontendCall, TypeFlowIssue } from "../types.js";
import { createProject } from "./typescript.js";

/**
 * Scans frontend code for fetch() and axios calls to API routes.
 *
 * Searches all `.ts` and `.tsx` files (excluding `route.ts`, `route.js`,
 * `node_modules`, and `.next` directories) for HTTP calls and extracts
 * the URL, method, file location, and expected response type.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Array of FrontendCall objects.
 */
export async function scanFrontendCalls(projectPath: string): Promise<FrontendCall[]> {
  const files = await glob("**/*.{ts,tsx}", {
    cwd: projectPath,
    absolute: true,
    ignore: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/route.ts",
      "**/route.js",
      "**/api/**/route.ts",
      "**/api/**/route.js",
    ],
  });

  if (files.length === 0) {
    return [];
  }

  const project = createProject(projectPath);
  const calls: FrontendCall[] = [];

  for (const filePath of files) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const fileCalls = extractCallsFromFile(sourceFile, filePath);
      calls.push(...fileCalls);
    } catch {
      /* skip: unreadable/unparseable file */
    }
  }

  return calls;
}

/**
 * Extracts fetch/axios API calls from a single source file.
 */
function extractCallsFromFile(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
  filePath: string,
): FrontendCall[] {
  const calls: FrontendCall[] = [];
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const callExpr of callExpressions) {
    try {
      const result = parseCallExpression(callExpr, filePath);
      if (result) {
        calls.push(result);
      }
    } catch {
      /* skip: unparseable expression */
    }
  }

  return calls;
}

/**
 * Attempts to parse a single call expression as an API call.
 *
 * Recognises:
 * - `fetch("/api/...", { method: "POST" })`
 * - `fetch(\`/api/${id}\`)`
 * - `axios.get("/api/...")`
 * - `axios.post("/api/...")`
 * - `axios("/api/...", { method: "POST" })`
 * - `$fetch`, `ofetch`, `ky`, `got` patterns
 */
function parseCallExpression(callExpr: Node, filePath: string): FrontendCall | null {
  if (!Node.isCallExpression(callExpr)) return null;

  const expression = callExpr.getExpression();
  const expressionText = expression.getText();
  const args = callExpr.getArguments();
  const line = callExpr.getStartLineNumber();

  // --- fetch() / $fetch() / ofetch() ---
  if (/^(fetch|\$fetch|ofetch|ky)$/.test(expressionText)) {
    if (args.length === 0) return null;
    const url = extractUrlFromArg(args[0]);
    if (!url || !looksLikeApiUrl(url)) return null;

    const method = args.length >= 2 ? extractMethodFromOptions(args[1]) : "GET";
    const expectedType = extractExpectedType(callExpr);

    return { url, method, file: filePath, line, expectedType };
  }

  // --- axios.get() / axios.post() / etc. ---
  if (Node.isPropertyAccessExpression(expression)) {
    const obj = expression.getExpression().getText();
    const methodName = expression.getName();

    if (/^(axios|api|http|client)$/i.test(obj)) {
      const httpMethod = methodName.toUpperCase();
      if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(httpMethod)) {
        if (args.length === 0) return null;
        const url = extractUrlFromArg(args[0]);
        if (!url || !looksLikeApiUrl(url)) return null;

        const expectedType = extractExpectedType(callExpr);
        return { url, method: httpMethod, file: filePath, line, expectedType };
      }
    }
  }

  // --- axios("/api/...", { method: "POST" }) ---
  if (/^(axios)$/.test(expressionText)) {
    if (args.length === 0) return null;
    const url = extractUrlFromArg(args[0]);
    if (!url || !looksLikeApiUrl(url)) return null;

    const method = args.length >= 2 ? extractMethodFromOptions(args[1]) : "GET";
    const expectedType = extractExpectedType(callExpr);

    return { url, method, file: filePath, line, expectedType };
  }

  return null;
}

/**
 * Extracts a URL string from a call argument.
 * Handles string literals and template literals (extracts static prefix).
 */
function extractUrlFromArg(arg: Node): string | null {
  // String literal: "/api/users"
  if (Node.isStringLiteral(arg)) {
    return arg.getLiteralText();
  }

  // No-substitution template literal: `/api/users`
  if (Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralText();
  }

  // Template literal with expressions: `/api/users/${id}`
  if (Node.isTemplateExpression(arg)) {
    const head = arg.getHead().getLiteralText();
    // Return the static prefix plus a wildcard indicator
    const spans = arg.getTemplateSpans();
    let url = head;
    for (const span of spans) {
      url += `*${span.getLiteral().getLiteralText()}`;
    }
    return url || null;
  }

  // Fallback: try to get the text and see if it's a recognizable URL
  const text = arg.getText();
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
    // Strip quotes
    const stripped = text.slice(1, -1);
    if (stripped.startsWith("/")) return stripped;
  }

  return null;
}

/**
 * Extracts the HTTP method from an options object argument.
 * Looks for `{ method: "POST" }` patterns.
 */
function extractMethodFromOptions(optionsArg: Node): string {
  if (!Node.isObjectLiteralExpression(optionsArg)) return "GET";

  const methodProp = optionsArg.getProperty("method");
  if (!methodProp || !Node.isPropertyAssignment(methodProp)) return "GET";

  const initializer = methodProp.getInitializer();
  if (!initializer) return "GET";

  if (Node.isStringLiteral(initializer)) {
    return initializer.getLiteralText().toUpperCase();
  }

  // Template literal or identifier — try text extraction
  const text = initializer.getText().replace(/["'`]/g, "").toUpperCase();
  if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(text)) {
    return text;
  }

  return "GET";
}

/**
 * Attempts to extract the expected response type from the call context.
 * Looks for `.json<Type>()`, type assertions, and generic type parameters.
 */
function extractExpectedType(callExpr: Node): string | null {
  const parent = callExpr.getParent();
  if (!parent) return null;

  // Look for type arguments on the call itself: fetch<ResponseType>(...)
  if (Node.isCallExpression(callExpr)) {
    const typeArgs = callExpr.getTypeArguments();
    if (typeArgs.length > 0) {
      return typeArgs[0].getText();
    }
  }

  // Check if the result is used with `as Type` assertion
  const grandParent = parent.getParent();
  if (grandParent && Node.isAsExpression(grandParent)) {
    return grandParent.getTypeNode()?.getText() ?? null;
  }

  // Check for chained .json<Type>() call
  const fullText = parent.getFullText();
  const jsonGeneric = fullText.match(/\.json\s*<\s*([^>]+)\s*>/);
  if (jsonGeneric) {
    return jsonGeneric[1].trim();
  }

  return null;
}

/**
 * Heuristic check: does this URL look like an API endpoint?
 */
function looksLikeApiUrl(url: string): boolean {
  return (
    url.startsWith("/api/") ||
    url.startsWith("/api") ||
    url.startsWith("/trpc") ||
    url.includes("/api/")
  );
}

// ---------------------------------------------------------------------------
// Type flow analysis — trace how frontend code uses API responses
// ---------------------------------------------------------------------------

/**
 * Traces how frontend code uses API response data to detect property
 * access patterns that may not match backend response shapes.
 *
 * For each frontend API call:
 * 1. Finds the variable that receives the fetch response (via `.json()`)
 * 2. Finds all property accesses on that variable in the same scope
 * 3. Collects these as "expected properties" for comparison with backend types
 *
 * @param projectPath    Absolute path to the project root.
 * @param frontendCalls  Frontend calls previously detected by scanFrontendCalls.
 * @returns              Array of TypeFlowIssue objects describing expected properties.
 */
export async function traceResponseUsage(
  projectPath: string,
  frontendCalls: FrontendCall[],
): Promise<TypeFlowIssue[]> {
  const issues: TypeFlowIssue[] = [];

  if (frontendCalls.length === 0) {
    return issues;
  }

  const project = createProject(projectPath);

  // Group calls by file to avoid re-parsing
  const callsByFile = new Map<string, FrontendCall[]>();
  for (const call of frontendCalls) {
    const existing = callsByFile.get(call.file) ?? [];
    existing.push(call);
    callsByFile.set(call.file, existing);
  }

  for (const [filePath, calls] of callsByFile) {
    try {
      let sourceFile;
      try {
        sourceFile = project.addSourceFileAtPath(filePath);
      } catch {
        /* skip: unreadable/unparseable file */
        continue;
      }

      for (const call of calls) {
        try {
          const callIssues = traceCallResponseUsage(sourceFile, call, filePath);
          issues.push(...callIssues);
        } catch {
          /* skip: individual call analysis failure */
        }
      }
    } catch {
      /* skip: unreadable/unparseable file */
    }
  }

  return issues;
}

/**
 * Traces property accesses for a single frontend API call within a source file.
 *
 * Looks for patterns like:
 * ```
 * const res = await fetch("/api/users");
 * const data = await res.json();
 * data.users.map(...)      // "users" is an expected property
 * data.totalCount           // "totalCount" is an expected property
 * ```
 */
function traceCallResponseUsage(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
  call: FrontendCall,
  filePath: string,
): TypeFlowIssue[] {
  const issues: TypeFlowIssue[] = [];

  // Find all variable declarations in the file
  const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);

  for (const varDecl of variableDeclarations) {
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const initText = initializer.getText();

    // Look for patterns like: await res.json(), await fetch(...).then(r => r.json())
    // We need to find the variable that holds the parsed JSON response
    const isJsonCall = initText.includes(".json()") || initText.includes(".json<");

    if (!isJsonCall) continue;

    // Check if this .json() call is related to our fetch call
    // by checking if the fetch URL appears nearby (within ~5 lines)
    const varLine = varDecl.getStartLineNumber();
    const lineDiff = Math.abs(varLine - call.line);
    if (lineDiff > 10) continue;

    const dataVarName = varDecl.getName();

    // Find all property accesses on this variable
    const propertyAccesses = findPropertyAccesses(sourceFile, dataVarName, varLine);

    for (const propPath of propertyAccesses) {
      issues.push({
        frontendFile: filePath,
        frontendLine: call.line,
        backendRoute: call.url,
        expectedProperty: propPath,
        description: `Frontend accesses "${propPath}" on response from ${call.method} ${call.url}`,
      });
    }
  }

  return issues;
}

/**
 * Finds all property access paths on a given variable name within a source file.
 *
 * For example, if variableName is "data" and the code has:
 *   data.users
 *   data.users.map(...)
 *   data.totalCount
 *
 * Returns: ["users", "totalCount"]
 *
 * Only returns top-level properties (not nested paths like "users.name").
 */
function findPropertyAccesses(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
  variableName: string,
  afterLine: number,
): string[] {
  const properties = new Set<string>();

  const propertyAccessNodes = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);

  for (const node of propertyAccessNodes) {
    // Only look at accesses after the variable declaration
    if (node.getStartLineNumber() < afterLine) continue;

    const expression = node.getExpression();

    // Direct access: data.property
    if (Node.isIdentifier(expression) && expression.getText() === variableName) {
      const propName = node.getName();
      // Skip common non-data methods
      if (
        !["then", "catch", "finally", "json", "text", "blob", "ok", "status", "headers"].includes(
          propName,
        )
      ) {
        properties.add(propName);
      }
    }
  }

  return [...properties];
}
