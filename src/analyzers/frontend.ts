// =============================================================================
// backend-max — Frontend API call detection
// =============================================================================

import { glob } from "glob";
import { join } from "node:path";
import { Project, SyntaxKind, Node } from "ts-morph";
import { createProject } from "./typescript.js";
import type { FrontendCall } from "../types.js";

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
export async function scanFrontendCalls(
  projectPath: string,
): Promise<FrontendCall[]> {
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
      // Skip files that can't be parsed
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
  const callExpressions = sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  );

  for (const callExpr of callExpressions) {
    try {
      const result = parseCallExpression(callExpr, filePath);
      if (result) {
        calls.push(result);
      }
    } catch {
      // Skip unparseable expressions
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
function parseCallExpression(
  callExpr: Node,
  filePath: string,
): FrontendCall | null {
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
      if (
        ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(
          httpMethod,
        )
      ) {
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
      url += "*" + span.getLiteral().getLiteralText();
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
  if (
    ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(text)
  ) {
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
