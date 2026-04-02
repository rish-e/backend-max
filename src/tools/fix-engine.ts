// =============================================================================
// backend-max — Fix engine (v2 — generates actual code patches)
// =============================================================================

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LedgerEntry } from "../types.js";
import { readJsonSafe } from "../utils/helpers.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";

/**
 * Escapes a string for safe interpolation into a template literal.
 * Replaces backticks and `${` sequences that would break template strings.
 */
function escapeForTemplate(str: string): string {
  return str.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
/** Ledger file name. */
const LEDGER_FILE = "ledger.json";

/** Result of attempting to fix an issue. */
export interface FixResult {
  /** Whether a patch was generated successfully. */
  success: boolean;
  /** Human-readable message about the fix. */
  message: string;
  /** Unified diff patch that can be applied with `git apply`. */
  patch?: string;
  /** Description of what the fix does. */
  description?: string;
  /** The file that would be modified. */
  file?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a code patch for a specific issue.
 *
 * Reads the source file, identifies the problematic code, and generates
 * a unified diff patch. Does NOT apply the patch — returns it for review.
 *
 * @param projectPath - Absolute path to the project root.
 * @param issueId     - The deterministic issue ID (e.g. "ERR-a1b2c3").
 * @returns A FixResult with the patch.
 */
export async function fixIssue(projectPath: string, issueId: string): Promise<FixResult> {
  const ledgerFilePath = join(projectPath, STATE_DIR, LEDGER_FILE);
  const ledger = await readJsonSafe<LedgerEntry[]>(ledgerFilePath, []);

  // Find the issue
  const entry = ledger.find((e) => e.id === issueId);

  if (!entry) {
    return {
      success: false,
      message: `Issue "${issueId}" not found in the ledger. Run a diagnosis first.`,
    };
  }

  if (entry.status === "fixed") {
    return {
      success: false,
      message: `Issue "${issueId}" is already marked as fixed (at ${entry.fixedAt}).`,
    };
  }

  // Try to generate a real patch
  const patchResult = await generatePatch(projectPath, entry);

  if (patchResult) {
    return {
      success: true,
      message: `Patch generated for "${entry.title}". Review the patch and apply with: git apply`,
      patch: patchResult.patch,
      description: patchResult.description,
      file: entry.file,
    };
  }

  // Fallback: generate a detailed fix description
  const description = generateFixDescription(entry);
  return {
    success: true,
    message: `Could not auto-generate a patch for "${entry.title}". Here is the recommended fix:`,
    description,
    file: entry.file,
  };
}

/**
 * Generates patches for all open issues in the ledger.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns Array of FixResults, one per open issue.
 */
export async function fixAllIssues(projectPath: string): Promise<FixResult[]> {
  const ledgerFilePath = join(projectPath, STATE_DIR, LEDGER_FILE);
  const ledger = await readJsonSafe<LedgerEntry[]>(ledgerFilePath, []);

  const openIssues = ledger.filter((e) => e.status === "open" || e.status === "regressed");

  if (openIssues.length === 0) {
    return [
      {
        success: true,
        message: "No open issues to fix. Your backend looks clean!",
      },
    ];
  }

  const results: FixResult[] = [];
  for (const entry of openIssues) {
    const result = await fixIssue(projectPath, entry.id);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Patch generation
// ---------------------------------------------------------------------------

interface PatchOutput {
  patch: string;
  description: string;
}

/**
 * Attempts to generate a unified diff patch for the given issue.
 */
async function generatePatch(projectPath: string, entry: LedgerEntry): Promise<PatchOutput | null> {
  try {
    const sourceContent = await readFile(entry.file, "utf-8");
    const lines = sourceContent.split("\n");
    const relPath = relative(projectPath, entry.file);

    // Dispatch to category-specific patch generators
    switch (entry.category) {
      case "error-handling":
        return generateErrorHandlingPatch(lines, entry, relPath);
      case "validation":
        return generateValidationPatch(lines, entry, relPath);
      case "security":
      case "auth":
        return generateAuthPatch(lines, entry, relPath);
      case "performance":
        return generatePerformancePatch(lines, entry, relPath);
      case "env":
        return generateEnvPatch(lines, entry, relPath);
      default:
        return null;
    }
  } catch {
    /* skip: unable to read/parse source file */
    return null;
  }
}

/**
 * Generates a patch to add try/catch error handling.
 */
function generateErrorHandlingPatch(
  lines: string[],
  entry: LedgerEntry,
  relPath: string,
): PatchOutput | null {
  if (!entry.line) return null;
  const lineIdx = entry.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  // Find the function body opening brace
  let braceIdx = -1;
  for (let i = lineIdx; i < Math.min(lineIdx + 10, lines.length); i++) {
    if (lines[i].includes("{")) {
      braceIdx = i;
      break;
    }
  }
  if (braceIdx === -1) return null;

  // Find the matching closing brace
  let depth = 0;
  let closingBraceIdx = -1;
  for (let i = braceIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          closingBraceIdx = i;
          break;
        }
      }
    }
    if (closingBraceIdx !== -1) break;
  }
  if (closingBraceIdx === -1) return null;

  // Get the indentation of the function body
  const bodyLine = lines[braceIdx + 1] ?? "";
  const baseIndent = bodyLine.match(/^(\s*)/)?.[1] ?? "  ";
  const innerIndent = `${baseIndent}  `;

  // Build the patched lines
  const originalBody = lines.slice(braceIdx + 1, closingBraceIdx);
  const wrappedBody = [
    `${baseIndent}try {`,
    ...originalBody.map((l) => (l.trim() ? `  ${l}` : l)),
    `${baseIndent}} catch (error) {`,
    `${innerIndent}console.error("${escapeForTemplate(entry.title)}:", error);`,
    `${innerIndent}return Response.json(`,
    `${innerIndent}  { error: "Internal server error" },`,
    `${innerIndent}  { status: 500 }`,
    `${innerIndent});`,
    `${baseIndent}}`,
  ];

  return {
    patch: buildUnifiedDiff(
      relPath,
      lines,
      braceIdx + 1,
      closingBraceIdx,
      originalBody,
      wrappedBody,
    ),
    description: "Wraps the handler body in a try/catch block with structured error response.",
  };
}

/**
 * Generates a patch to add Zod input validation.
 */
function generateValidationPatch(
  lines: string[],
  entry: LedgerEntry,
  relPath: string,
): PatchOutput | null {
  if (!entry.line) return null;
  const lineIdx = entry.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  // Find the function body start
  let braceIdx = -1;
  for (let i = lineIdx; i < Math.min(lineIdx + 10, lines.length); i++) {
    if (lines[i].includes("{")) {
      braceIdx = i;
      break;
    }
  }
  if (braceIdx === -1) return null;

  const bodyLine = lines[braceIdx + 1] ?? "";
  const baseIndent = bodyLine.match(/^(\s*)/)?.[1] ?? "  ";

  // Determine if this is an Express or Next.js handler
  const handlerLine = lines[lineIdx];
  const isExpress = /req\s*,\s*res/.test(handlerLine);

  const validationLines = isExpress
    ? [
        `${baseIndent}// Input validation`,
        `${baseIndent}const schema = z.object({`,
        `${baseIndent}  // TODO: Define your expected request body shape`,
        `${baseIndent}  // name: z.string().min(1),`,
        `${baseIndent}  // email: z.string().email(),`,
        `${baseIndent}});`,
        `${baseIndent}const parsed = schema.safeParse(req.body);`,
        `${baseIndent}if (!parsed.success) {`,
        `${baseIndent}  return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });`,
        `${baseIndent}}`,
        `${baseIndent}const data = parsed.data;`,
        ``,
      ]
    : [
        `${baseIndent}// Input validation`,
        `${baseIndent}const schema = z.object({`,
        `${baseIndent}  // TODO: Define your expected request body shape`,
        `${baseIndent}  // name: z.string().min(1),`,
        `${baseIndent}  // email: z.string().email(),`,
        `${baseIndent}});`,
        `${baseIndent}const body = await request.json();`,
        `${baseIndent}const parsed = schema.safeParse(body);`,
        `${baseIndent}if (!parsed.success) {`,
        `${baseIndent}  return Response.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });`,
        `${baseIndent}}`,
        `${baseIndent}const data = parsed.data;`,
        ``,
      ];

  // Check if zod is already imported
  let hasZodImport = false;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    if (/import.*zod|import.*z\b/.test(lines[i])) {
      hasZodImport = true;
      break;
    }
  }

  const patchLines: string[] = [];
  if (!hasZodImport) {
    patchLines.push(`import { z } from "zod";`);
    patchLines.push(``);
  }

  return {
    patch: buildInsertionDiff(
      relPath,
      lines,
      braceIdx + 1,
      validationLines,
      !hasZodImport ? `import { z } from "zod";\n` : undefined,
    ),
    description:
      "Adds Zod schema validation for request body. Fill in the schema fields for your endpoint.",
  };
}

/**
 * Generates a patch to add auth middleware/check.
 */
function generateAuthPatch(
  lines: string[],
  entry: LedgerEntry,
  relPath: string,
): PatchOutput | null {
  if (!entry.line) return null;
  const lineIdx = entry.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  // Find the function body start
  let braceIdx = -1;
  for (let i = lineIdx; i < Math.min(lineIdx + 10, lines.length); i++) {
    if (lines[i].includes("{")) {
      braceIdx = i;
      break;
    }
  }
  if (braceIdx === -1) return null;

  const bodyLine = lines[braceIdx + 1] ?? "";
  const baseIndent = bodyLine.match(/^(\s*)/)?.[1] ?? "  ";

  const isExpress = /req\s*,\s*res/.test(lines[lineIdx]);

  const authLines = isExpress
    ? [
        `${baseIndent}// Auth check`,
        `${baseIndent}// TODO: Replace with your auth verification logic`,
        `${baseIndent}const session = req.session; // or verify JWT from req.headers.authorization`,
        `${baseIndent}if (!session?.user) {`,
        `${baseIndent}  return res.status(401).json({ error: "Unauthorized" });`,
        `${baseIndent}}`,
        ``,
      ]
    : [
        `${baseIndent}// Auth check`,
        `${baseIndent}// TODO: Replace with your auth verification logic (e.g., getServerSession, auth())`,
        `${baseIndent}const session = await getServerSession();`,
        `${baseIndent}if (!session?.user) {`,
        `${baseIndent}  return Response.json({ error: "Unauthorized" }, { status: 401 });`,
        `${baseIndent}}`,
        ``,
      ];

  return {
    patch: buildInsertionDiff(relPath, lines, braceIdx + 1, authLines),
    description:
      "Adds an authentication check at the start of the handler. Replace with your actual auth logic.",
  };
}

/**
 * Generates a patch for performance issues (pagination, select, etc.).
 */
function generatePerformancePatch(
  lines: string[],
  entry: LedgerEntry,
  relPath: string,
): PatchOutput | null {
  if (!entry.line) return null;
  const lineIdx = entry.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  const line = lines[lineIdx];

  // Detect findMany without take/limit
  if (/findMany\s*\(/.test(line) && !/take\s*:/.test(line)) {
    const _indent = line.match(/^(\s*)/)?.[1] ?? "";

    // Find the closing of the findMany call
    let endIdx = lineIdx;
    let depth = 0;
    for (let i = lineIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "(") depth++;
        if (ch === ")") {
          depth--;
          if (depth === 0) {
            endIdx = i;
            break;
          }
        }
      }
      if (depth === 0 && endIdx !== lineIdx) break;
    }

    // If it's a simple findMany() with no args, add pagination
    if (endIdx === lineIdx && /findMany\s*\(\s*\)/.test(line)) {
      const newLine = line.replace(
        /findMany\s*\(\s*\)/,
        `findMany({ take: 50 }) // TODO: Add proper pagination`,
      );

      return {
        patch: buildReplaceDiff(relPath, lines, lineIdx, lineIdx + 1, [newLine]),
        description:
          "Adds a default limit to the database query to prevent unbounded results. Adjust the limit and add cursor-based pagination.",
      };
    }

    // If findMany has args but no take, inject take into the options
    if (/findMany\s*\(\s*\{/.test(line)) {
      const newLine = line.replace(
        /findMany\s*\(\s*\{/,
        `findMany({ take: 50, // TODO: Add proper pagination`,
      );

      return {
        patch: buildReplaceDiff(relPath, lines, lineIdx, lineIdx + 1, [newLine]),
        description: "Adds a default limit to prevent unbounded database queries.",
      };
    }
  }

  return null;
}

/**
 * Generates a patch for missing environment variable checks.
 */
function generateEnvPatch(
  lines: string[],
  entry: LedgerEntry,
  relPath: string,
): PatchOutput | null {
  if (!entry.line) return null;
  const lineIdx = entry.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  const line = lines[lineIdx];

  // Find the env var name
  const envMatch = line.match(/process\.env\.(\w+)/);
  if (!envMatch) return null;

  const envVarName = envMatch[1];
  const indent = line.match(/^(\s*)/)?.[1] ?? "";

  // Add a runtime check before the usage
  const checkLines = [
    `${indent}if (!process.env.${envVarName}) {`,
    `${indent}  throw new Error("Missing required environment variable: ${envVarName}");`,
    `${indent}}`,
  ];

  return {
    patch: buildInsertionDiff(relPath, lines, lineIdx, checkLines),
    description: `Adds a runtime check for the ${envVarName} environment variable before it is used.`,
  };
}

// ---------------------------------------------------------------------------
// Unified diff helpers
// ---------------------------------------------------------------------------

/**
 * Builds a unified diff for replacing a range of lines.
 */
function buildUnifiedDiff(
  relPath: string,
  allLines: string[],
  startLine: number,
  endLine: number,
  originalLines: string[],
  newLines: string[],
): string {
  const context = 3;
  const ctxStart = Math.max(0, startLine - context);
  const ctxEnd = Math.min(allLines.length, endLine + context);

  const header = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${ctxStart + 1},${ctxEnd - ctxStart} +${ctxStart + 1},${ctxEnd - ctxStart - originalLines.length + newLines.length} @@`,
  ];

  const diffLines: string[] = [...header];

  // Leading context
  for (let i = ctxStart; i < startLine; i++) {
    diffLines.push(` ${allLines[i]}`);
  }

  // Removed lines
  for (const line of originalLines) {
    diffLines.push(`-${line}`);
  }

  // Added lines
  for (const line of newLines) {
    diffLines.push(`+${line}`);
  }

  // Trailing context
  for (let i = endLine; i < ctxEnd; i++) {
    diffLines.push(` ${allLines[i]}`);
  }

  return diffLines.join("\n");
}

/**
 * Builds a unified diff for inserting lines at a position.
 */
function buildInsertionDiff(
  relPath: string,
  allLines: string[],
  insertAt: number,
  newLines: string[],
  headerInsert?: string,
): string {
  const context = 3;
  const ctxStart = Math.max(0, insertAt - context);
  const ctxEnd = Math.min(allLines.length, insertAt + context);

  const diffParts: string[] = [];

  // Optional header insertion (e.g., import statement at top of file)
  if (headerInsert) {
    diffParts.push(`--- a/${relPath}`);
    diffParts.push(`+++ b/${relPath}`);
    diffParts.push(`@@ -1,3 +1,4 @@`);
    diffParts.push(` ${allLines[0]}`);
    diffParts.push(`+${headerInsert.trimEnd()}`);
    diffParts.push(` ${allLines[1]}`);
    diffParts.push(` ${allLines[2]}`);
    diffParts.push(``);
  }

  diffParts.push(`--- a/${relPath}`);
  diffParts.push(`+++ b/${relPath}`);
  diffParts.push(
    `@@ -${ctxStart + 1},${ctxEnd - ctxStart} +${ctxStart + 1},${ctxEnd - ctxStart + newLines.length} @@`,
  );

  // Leading context
  for (let i = ctxStart; i < insertAt; i++) {
    diffParts.push(` ${allLines[i]}`);
  }

  // Inserted lines
  for (const line of newLines) {
    diffParts.push(`+${line}`);
  }

  // Trailing context
  for (let i = insertAt; i < ctxEnd; i++) {
    diffParts.push(` ${allLines[i]}`);
  }

  return diffParts.join("\n");
}

/**
 * Builds a unified diff for replacing specific lines.
 */
function buildReplaceDiff(
  relPath: string,
  allLines: string[],
  startLine: number,
  endLine: number,
  newLines: string[],
): string {
  const context = 3;
  const ctxStart = Math.max(0, startLine - context);
  const ctxEnd = Math.min(allLines.length, endLine + context);

  const diffLines: string[] = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${ctxStart + 1},${ctxEnd - ctxStart} +${ctxStart + 1},${ctxEnd - ctxStart - (endLine - startLine) + newLines.length} @@`,
  ];

  // Leading context
  for (let i = ctxStart; i < startLine; i++) {
    diffLines.push(` ${allLines[i]}`);
  }

  // Removed lines
  for (let i = startLine; i < endLine; i++) {
    diffLines.push(`-${allLines[i]}`);
  }

  // Added lines
  for (const line of newLines) {
    diffLines.push(`+${line}`);
  }

  // Trailing context
  for (let i = endLine; i < ctxEnd; i++) {
    diffLines.push(` ${allLines[i]}`);
  }

  return diffLines.join("\n");
}

// ---------------------------------------------------------------------------
// Fix description fallback
// ---------------------------------------------------------------------------

/**
 * Generates a detailed human-readable fix description when auto-patching
 * isn't possible.
 */
function generateFixDescription(entry: LedgerEntry): string {
  const descriptions: Record<string, (e: LedgerEntry) => string> = {
    "error-handling": (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Wrap the handler body in a try/catch block:\n` +
      "```typescript\n" +
      "try {\n" +
      "  // ... existing handler logic\n" +
      "} catch (error) {\n" +
      '  console.error("Handler error:", error);\n' +
      "  return Response.json(\n" +
      '    { error: "Internal server error" },\n' +
      "    { status: 500 }\n" +
      "  );\n" +
      "}\n" +
      "```",

    validation: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Add Zod validation at the start of the handler:\n` +
      "```typescript\n" +
      'import { z } from "zod";\n\n' +
      "const schema = z.object({\n" +
      "  // Define expected fields\n" +
      "});\n\n" +
      "const parsed = schema.safeParse(body);\n" +
      "if (!parsed.success) {\n" +
      "  return Response.json(\n" +
      '    { error: "Validation failed", details: parsed.error.flatten() },\n' +
      "    { status: 400 }\n" +
      "  );\n" +
      "}\n" +
      "```",

    contract: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Verify the frontend API call matches the backend route:\n` +
      "- Check URL path matches the backend route pattern\n" +
      "- Check HTTP method matches the exported handler\n" +
      "- Check request/response payload shapes match",

    env: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Add the missing environment variable to your .env file and add a runtime check:\n` +
      "```typescript\n" +
      "if (!process.env.VARIABLE_NAME) {\n" +
      '  throw new Error("Missing required env var: VARIABLE_NAME");\n' +
      "}\n" +
      "```",

    security: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Add authentication/authorization before accessing sensitive data:\n` +
      "```typescript\n" +
      "const session = await getServerSession();\n" +
      "if (!session?.user) {\n" +
      '  return Response.json({ error: "Unauthorized" }, { status: 401 });\n' +
      "}\n" +
      "```",

    performance: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Add pagination and limit selected fields:\n` +
      "```typescript\n" +
      "const results = await prisma.model.findMany({\n" +
      "  take: 50,\n" +
      "  skip: page * 50,\n" +
      "  select: { id: true, name: true }, // Only needed fields\n" +
      "});\n" +
      "```",

    auth: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Add session/token verification at the start of the handler.`,

    prisma: (e) =>
      `**File:** ${e.file}:${e.line ?? "?"}\n\n` +
      `**Problem:** ${e.description}\n\n` +
      `**Fix:** Check your Prisma schema matches the database call. Run \`npx prisma db push\` after schema changes.`,
  };

  const generator = descriptions[entry.category];
  if (generator) {
    return generator(entry);
  }

  return (
    `**File:** ${entry.file}:${entry.line ?? "?"}\n\n` +
    `**Problem:** ${entry.description}\n\n` +
    `**Fix:** Review and fix the issue at the indicated location.`
  );
}
