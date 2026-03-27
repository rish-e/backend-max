// =============================================================================
// backend-max — Core TypeScript analysis utilities (ts-morph)
// =============================================================================

import {
  Project,
  SourceFile,
  SyntaxKind,
  Node,
  FunctionDeclaration,
  ts,
} from "ts-morph";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MethodInfo } from "../types.js";

/** HTTP methods that Next.js route handlers can export. */
const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
] as const;

// ---------------------------------------------------------------------------
// Project creation
// ---------------------------------------------------------------------------

/**
 * Creates a ts-morph Project configured for the given project directory.
 *
 * If a `tsconfig.json` exists at the project root it will be used;
 * otherwise a sensible default compiler configuration is applied so that
 * files can still be parsed without errors.
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            A configured ts-morph Project instance.
 */
export function createProject(projectPath: string): Project {
  const tsconfigPath = join(projectPath, "tsconfig.json");

  if (existsSync(tsconfigPath)) {
    try {
      return new Project({
        tsConfigFilePath: tsconfigPath,
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
      });
    } catch {
      // tsconfig might be malformed — fall through to default config
    }
  }

  return new Project({
    skipFileDependencyResolution: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: false,
      allowJs: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Exported HTTP method extraction
// ---------------------------------------------------------------------------

/**
 * Finds all exported HTTP method handlers in a Next.js route file.
 *
 * Looks for patterns such as:
 * - `export async function GET(req) { ... }`
 * - `export const POST = async (req) => { ... }`
 *
 * @param sourceFile  A ts-morph SourceFile to analyze.
 * @returns           Array of MethodInfo objects for each handler found.
 */
export function extractExportedMethods(sourceFile: SourceFile): MethodInfo[] {
  const methods: MethodInfo[] = [];

  for (const httpMethod of HTTP_METHODS) {
    // --- Pattern 1: export [async] function METHOD ---
    for (const func of sourceFile.getFunctions()) {
      if (func.getName() === httpMethod && func.isExported()) {
        methods.push(buildMethodInfo(httpMethod, func, func));
      }
    }

    // --- Pattern 2: export const METHOD = ... ---
    for (const varStatement of sourceFile.getVariableStatements()) {
      if (!varStatement.isExported()) continue;

      for (const decl of varStatement.getDeclarations()) {
        if (decl.getName() !== httpMethod) continue;

        const initializer = decl.getInitializer();
        if (!initializer) continue;

        methods.push(
          buildMethodInfo(
            httpMethod,
            initializer,
            initializer,
            decl.getStartLineNumber(),
          ),
        );
      }
    }
  }

  return methods;
}

/**
 * Builds a MethodInfo from an AST node representing the handler body.
 */
function buildMethodInfo(
  method: string,
  bodyNode: Node,
  typeNode: Node,
  lineOverride?: number,
): MethodInfo {
  return {
    method,
    hasValidation: detectValidation(bodyNode),
    hasErrorHandling: detectErrorHandling(bodyNode),
    hasDatabaseCalls: detectDatabaseCalls(bodyNode).length > 0,
    hasAuth: detectAuthPatterns(bodyNode),
    returnType: getReturnTypeFromNode(typeNode),
    databaseCalls: detectDatabaseCalls(bodyNode),
    lineNumber: lineOverride ?? bodyNode.getStartLineNumber(),
  };
}

// ---------------------------------------------------------------------------
// Validation detection
// ---------------------------------------------------------------------------

/**
 * Checks whether a function body references validation libraries
 * (Zod, Yup, Joi, Superstruct, Valibot, ArkType, or a generic `.parse`/`.validate` call).
 *
 * @param node  AST node to inspect.
 * @returns     True if validation patterns are detected.
 */
export function detectValidation(node: Node): boolean {
  const text = node.getFullText();
  const patterns = [
    /\.parse\s*\(/,
    /\.safeParse\s*\(/,
    /\.validate\s*\(/,
    /\.validateAsync\s*\(/,
    /z\.\w+/,
    /zod/i,
    /yup\./i,
    /joi\./i,
    /superstruct/i,
    /valibot/i,
    /arktype/i,
    /\.schema\s*\(/,
  ];

  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Database call detection
// ---------------------------------------------------------------------------

/**
 * Finds database call expressions in the given AST node.
 *
 * Recognises Prisma (`prisma.model.method`), Drizzle (`db.select/insert/...`),
 * Kysely, Knex, TypeORM, and raw SQL helpers.
 *
 * @param node  AST node to inspect.
 * @returns     Array of matched call expression strings.
 */
export function detectDatabaseCalls(node: Node): string[] {
  const text = node.getFullText();
  const calls: string[] = [];
  const seen = new Set<string>();

  // Prisma: prisma.user.findMany(), prisma.$queryRaw, etc.
  const prismaRegex = /prisma\.\w+\.\w+(?:\([^)]*\))?/g;
  const prismaRawRegex = /prisma\.\$\w+(?:\([^)]*\))?/g;

  // Drizzle: db.select(), db.insert(), db.update(), db.delete(), db.query.*
  const drizzleRegex = /db\.(select|insert|update|delete|query)\b/g;

  // Generic SQL/ORM patterns
  const genericRegex =
    /(?:knex|kysely|typeorm|sequelize|mongoose)\b[^;]*/gi;

  for (const regex of [prismaRegex, prismaRawRegex, drizzleRegex, genericRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const normalized = match[0].trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        calls.push(normalized);
      }
    }
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Error handling detection
// ---------------------------------------------------------------------------

/**
 * Checks whether the node contains try/catch blocks.
 *
 * @param node  AST node to inspect.
 * @returns     True if at least one try statement is found.
 */
export function detectErrorHandling(node: Node): boolean {
  // Check for try statements in descendants
  const tryStatements = node.getDescendantsOfKind(SyntaxKind.TryStatement);
  if (tryStatements.length > 0) return true;

  // Fallback: text-based check (handles cases where ts-morph can't fully parse)
  const text = node.getFullText();
  return /\btry\s*\{/.test(text) && /\bcatch\s*\(/.test(text);
}

// ---------------------------------------------------------------------------
// Auth pattern detection
// ---------------------------------------------------------------------------

/**
 * Checks whether the node references common authentication / authorization
 * patterns.
 *
 * Looks for: getServerSession, getSession, auth(), currentUser, getToken,
 * requireAuth, withAuth, clerkClient, headers().get("authorization"), etc.
 *
 * @param node  AST node to inspect.
 * @returns     True if auth patterns are detected.
 */
export function detectAuthPatterns(node: Node): boolean {
  const text = node.getFullText();
  const patterns = [
    /getServerSession/,
    /getSession/,
    /\bauth\s*\(\)/,
    /currentUser/,
    /getToken/,
    /requireAuth/,
    /withAuth/,
    /clerkClient/,
    /clerk/i,
    /supabase\.auth/,
    /authorization/i,
    /authenticate/i,
    /isAuthenticated/,
    /session\./,
    /NextAuth/,
    /getAuth/,
  ];

  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Return type extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the return type annotation from a function declaration.
 *
 * @param func  A ts-morph FunctionDeclaration.
 * @returns     The return type as a string, or null if not annotated.
 */
export function getReturnType(func: FunctionDeclaration): string | null {
  const returnTypeNode = func.getReturnTypeNode();
  if (returnTypeNode) {
    return returnTypeNode.getText();
  }
  return null;
}

/**
 * Attempts to extract the return type from any node that might have a type
 * annotation (function declarations, arrow functions, variable declarations).
 *
 * @param node  AST node to inspect.
 * @returns     Return type string or null.
 */
function getReturnTypeFromNode(node: Node): string | null {
  // FunctionDeclaration / FunctionExpression
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node)) {
    const rt = node.getReturnTypeNode();
    return rt ? rt.getText() : null;
  }

  // ArrowFunction
  if (Node.isArrowFunction(node)) {
    const rt = node.getReturnTypeNode();
    return rt ? rt.getText() : null;
  }

  // Variable declaration with type annotation
  if (Node.isVariableDeclaration(node)) {
    const typeNode = node.getTypeNode();
    return typeNode ? typeNode.getText() : null;
  }

  return null;
}
