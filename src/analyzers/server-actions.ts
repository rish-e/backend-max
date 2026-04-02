// =============================================================================
// backend-max — Next.js Server Actions analyzer
//
// Detects and analyzes Server Actions ('use server' directive) in Next.js
// projects, extracting metadata about validation, error handling, auth, and
// database usage.
// =============================================================================

import { glob } from "glob";
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { ServerAction } from "../types.js";
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

const SOURCE_PATTERNS = [
  "app/**/*.{ts,tsx}",
  "src/app/**/*.{ts,tsx}",
  "src/actions/**/*.{ts,tsx}",
  "src/lib/**/*.{ts,tsx}",
  "actions/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
];

const IGNORE_DIRS = ["node_modules/**", ".next/**", "dist/**", "build/**", ".git/**"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans a Next.js project for Server Actions.
 *
 * Detects both file-level (`'use server'` at the top of a file, making all
 * exports server actions) and inline (`'use server'` inside a function body)
 * patterns.
 *
 * For each server action, extracts:
 * - Function name, file path, and line number
 * - Whether it has validation (Zod, etc.)
 * - Whether it has error handling (try/catch)
 * - Whether it makes database calls
 * - Whether it has auth checks
 *
 * @param projectPath  Absolute path to the project root.
 * @returns            Array of detected ServerAction objects.
 */
export async function scanServerActions(projectPath: string): Promise<ServerAction[]> {
  const actions: ServerAction[] = [];

  // Discover source files
  const files: string[] = [];
  for (const pattern of SOURCE_PATTERNS) {
    const matches = await glob(pattern, {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: IGNORE_DIRS,
    });
    files.push(...matches);
  }

  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0) {
    return actions;
  }

  const project = createProject(projectPath);

  for (const filePath of uniqueFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const fullText = sourceFile.getFullText();

      // Check if this file contains 'use server' at all
      if (!fullText.includes("use server")) {
        continue;
      }

      // Determine if 'use server' is a file-level directive
      const isFileLevel = isFileLevelDirective(fullText);

      if (isFileLevel) {
        // All exported functions in this file are server actions
        const exportedActions = extractFileLevelActions(sourceFile, filePath);
        actions.push(...exportedActions);
      } else {
        // Look for inline 'use server' inside individual functions
        const inlineActions = extractInlineActions(sourceFile, filePath);
        actions.push(...inlineActions);
      }
    } catch {
      /* skip: unreadable/unparseable file */
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// File-level directive detection
// ---------------------------------------------------------------------------

/**
 * Checks whether `'use server'` or `"use server"` appears as a top-level
 * directive (before any import/export/declaration).
 */
function isFileLevelDirective(fullText: string): boolean {
  // The directive must be one of the first statements in the file,
  // before any actual code (imports are okay before it in some setups,
  // but the standard pattern is the very first statement).
  const lines = fullText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }
    // Check if this is the 'use server' directive
    if (
      trimmed === "'use server'" ||
      trimmed === '"use server"' ||
      trimmed === "'use server';" ||
      trimmed === '"use server";'
    ) {
      return true;
    }
    // If we hit an import or other code first, it's not file-level
    // (unless it's a comment block)
    if (trimmed.startsWith("import") || trimmed.startsWith("export")) {
      return false;
    }
    // Any other non-comment, non-empty line means it's not file-level
    break;
  }

  return false;
}

// ---------------------------------------------------------------------------
// File-level action extraction
// ---------------------------------------------------------------------------

/**
 * Extracts all exported functions from a file with a file-level 'use server' directive.
 */
function extractFileLevelActions(sourceFile: SourceFile, filePath: string): ServerAction[] {
  const actions: ServerAction[] = [];

  // Exported function declarations: export async function doSomething() {}
  for (const func of sourceFile.getFunctions()) {
    if (func.isExported()) {
      const name = func.getName() ?? "anonymous";
      const dbCalls = detectDatabaseCalls(func);
      actions.push({
        name,
        filePath,
        line: func.getStartLineNumber(),
        hasValidation: detectValidation(func),
        hasErrorHandling: detectErrorHandling(func),
        hasDatabaseCalls: dbCalls.length > 0,
        hasAuth: detectAuthPatterns(func),
        databaseCalls: dbCalls,
        isFileLevel: true,
      });
    }
  }

  // Exported variable declarations: export const doSomething = async () => {}
  for (const varStatement of sourceFile.getVariableStatements()) {
    if (!varStatement.isExported()) continue;

    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
        const name = decl.getName();
        const dbCalls = detectDatabaseCalls(initializer);
        actions.push({
          name,
          filePath,
          line: decl.getStartLineNumber(),
          hasValidation: detectValidation(initializer),
          hasErrorHandling: detectErrorHandling(initializer),
          hasDatabaseCalls: dbCalls.length > 0,
          hasAuth: detectAuthPatterns(initializer),
          databaseCalls: dbCalls,
          isFileLevel: true,
        });
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Inline action extraction
// ---------------------------------------------------------------------------

/**
 * Extracts functions that contain an inline 'use server' directive.
 */
function extractInlineActions(sourceFile: SourceFile, filePath: string): ServerAction[] {
  const actions: ServerAction[] = [];

  // Check all function declarations
  for (const func of sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (hasInlineUseServer(func)) {
      const name = func.getName() ?? "anonymous";
      const dbCalls = detectDatabaseCalls(func);
      actions.push({
        name,
        filePath,
        line: func.getStartLineNumber(),
        hasValidation: detectValidation(func),
        hasErrorHandling: detectErrorHandling(func),
        hasDatabaseCalls: dbCalls.length > 0,
        hasAuth: detectAuthPatterns(func),
        databaseCalls: dbCalls,
        isFileLevel: false,
      });
    }
  }

  // Check all arrow functions assigned to variables
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      if (
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) &&
        hasInlineUseServer(initializer)
      ) {
        const name = decl.getName();
        const dbCalls = detectDatabaseCalls(initializer);
        actions.push({
          name,
          filePath,
          line: decl.getStartLineNumber(),
          hasValidation: detectValidation(initializer),
          hasErrorHandling: detectErrorHandling(initializer),
          hasDatabaseCalls: dbCalls.length > 0,
          hasAuth: detectAuthPatterns(initializer),
          databaseCalls: dbCalls,
          isFileLevel: false,
        });
      }
    }
  }

  return actions;
}

/**
 * Checks if a function node contains an inline 'use server' directive
 * as the first expression statement in its body.
 */
function hasInlineUseServer(node: Node): boolean {
  const text = node.getFullText();
  return text.includes("'use server'") || text.includes('"use server"');
}
