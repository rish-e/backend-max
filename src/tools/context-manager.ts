// =============================================================================
// backend-max — Project context manager
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import type { ProjectContext } from "../types.js";
import { ensureDir, writeJson } from "../utils/helpers.js";

/** Directory where backend-max stores its state. */
const STATE_DIR = ".backend-doctor";
/** File path (relative to project root) for persisted context. */
const CONTEXT_FILE = "context.json";

// ---------------------------------------------------------------------------
// Framework / database / auth detection maps
// ---------------------------------------------------------------------------

const FRAMEWORK_INDICATORS: Record<string, string> = {
  next: "nextjs",
  express: "express",
  fastify: "fastify",
  hono: "hono",
  koa: "koa",
  "@nestjs/core": "nestjs",
  nuxt: "nuxt",
  remix: "remix",
};

const DATABASE_INDICATORS: Record<string, string> = {
  prisma: "prisma",
  "@prisma/client": "prisma",
  drizzle: "drizzle",
  "drizzle-orm": "drizzle",
  mongoose: "mongoose",
  mongodb: "mongodb",
  typeorm: "typeorm",
  sequelize: "sequelize",
  knex: "knex",
  "better-sqlite3": "sqlite",
  pg: "postgres",
  mysql2: "mysql",
};

const AUTH_INDICATORS: Record<string, string> = {
  "next-auth": "next-auth",
  "@auth/core": "auth.js",
  "@clerk/nextjs": "clerk",
  "@clerk/express": "clerk",
  lucia: "lucia",
  "lucia-auth": "lucia",
  "@supabase/auth-helpers-nextjs": "supabase-auth",
  passport: "passport",
  "better-auth": "better-auth",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the state directory for a project.
 */
function statePath(projectPath: string): string {
  return join(projectPath, STATE_DIR);
}

/**
 * Returns the absolute path to the context file for a project.
 */
function contextFilePath(projectPath: string): string {
  return join(statePath(projectPath), CONTEXT_FILE);
}

/**
 * Detects a value from a dependency map by checking `dependencies` and
 * `devDependencies` in the parsed package.json.
 */
function detectFromDeps(
  pkg: Record<string, unknown>,
  indicators: Record<string, string>,
): string | null {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  for (const [key, label] of Object.entries(indicators)) {
    if (key in deps) {
      return label;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initializes the project context by scanning the project for framework,
 * database, auth, routes, and README info.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns The fully populated ProjectContext.
 */
export async function initContext(projectPath: string): Promise<ProjectContext> {
  await ensureDir(statePath(projectPath));

  // 1. Read package.json
  let pkg: Record<string, unknown> = {};
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      pkg = parsed;
    }
  } catch {
    /* skip: package.json missing or unreadable — continue with defaults */
  }

  const projectName = (pkg.name as string) ?? projectPath.split("/").pop() ?? "unknown";

  // 2. Detect framework
  const framework = detectFromDeps(pkg, FRAMEWORK_INDICATORS) ?? "unknown";

  // 3. Detect database
  const database = detectFromDeps(pkg, DATABASE_INDICATORS);

  // 4. Detect auth
  const auth = detectFromDeps(pkg, AUTH_INDICATORS);

  // 5. Scan routes and identify domains
  const domains = await detectDomains(projectPath, framework);

  // 6. Read README for notes
  const notes: string[] = [];
  try {
    const readme = await readFile(join(projectPath, "README.md"), "utf-8");
    const snippet = readme.slice(0, 500).trim();
    if (snippet) {
      notes.push(snippet);
    }
  } catch {
    /* skip: no README — that's fine */
  }

  const context: ProjectContext = {
    name: projectName,
    type: framework,
    framework,
    database,
    auth,
    domains,
    notes,
  };

  await writeJson(contextFilePath(projectPath), context);
  return context;
}

/**
 * Reads and returns the previously saved project context.
 *
 * @param projectPath - Absolute path to the project root.
 * @returns The persisted ProjectContext.
 * @throws If no context file exists.
 */
export async function getContext(projectPath: string): Promise<ProjectContext> {
  try {
    const raw = await readFile(contextFilePath(projectPath), "utf-8");
    return JSON.parse(raw) as ProjectContext;
  } catch {
    throw new Error(
      `No project context found at ${contextFilePath(projectPath)}. Run initContext first.`,
    );
  }
}

/**
 * Merges partial updates into the existing project context and persists the
 * result.
 *
 * @param projectPath - Absolute path to the project root.
 * @param updates     - Partial fields to merge.
 * @returns The updated ProjectContext.
 */
export async function updateContext(
  projectPath: string,
  updates: Partial<ProjectContext>,
): Promise<ProjectContext> {
  const existing = await getContext(projectPath);
  const merged: ProjectContext = { ...existing, ...updates };
  await ensureDir(statePath(projectPath));
  await writeJson(contextFilePath(projectPath), merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Domain detection
// ---------------------------------------------------------------------------

/**
 * Detects business domains by scanning route files and grouping them by
 * top-level path segment (e.g. /api/users/* -> "users").
 */
async function detectDomains(projectPath: string, framework: string): Promise<string[]> {
  const domainSet = new Set<string>();

  // Determine where to look for route files
  const routePatterns: string[] = [];

  if (framework === "nextjs" || framework === "nuxt") {
    routePatterns.push(
      "app/**/route.{ts,js}",
      "src/app/**/route.{ts,js}",
      "pages/api/**/*.{ts,js}",
      "src/pages/api/**/*.{ts,js}",
    );
  } else {
    // Express / Fastify / generic — look for common patterns
    routePatterns.push(
      "src/routes/**/*.{ts,js}",
      "routes/**/*.{ts,js}",
      "src/api/**/*.{ts,js}",
      "api/**/*.{ts,js}",
    );
  }

  for (const pattern of routePatterns) {
    const files = await glob(pattern, {
      cwd: projectPath,
      absolute: false,
      nodir: true,
      ignore: ["**/node_modules/**"],
    }).catch(() => []);

    for (const file of files) {
      const domain = extractDomainFromPath(file);
      if (domain) {
        domainSet.add(domain);
      }
    }
  }

  return Array.from(domainSet).sort();
}

/**
 * Extracts the domain name from a route file path by finding the first
 * meaningful path segment after `api/`.
 *
 * Examples:
 *   "app/api/users/[id]/route.ts" -> "users"
 *   "src/pages/api/billing/invoices.ts" -> "billing"
 */
function extractDomainFromPath(filePath: string): string | null {
  const segments = filePath.split("/");
  const apiIndex = segments.indexOf("api");

  if (apiIndex === -1 || apiIndex + 1 >= segments.length) {
    return null;
  }

  const domainSegment = segments[apiIndex + 1];

  // Skip if it's the route file itself or a route group
  if (!domainSegment || /^route\.(ts|js)$/.test(domainSegment) || /^\(.*\)$/.test(domainSegment)) {
    return null;
  }

  // Clean up dynamic segments — [id] isn't a domain
  if (/^\[/.test(domainSegment)) {
    return null;
  }

  return domainSegment;
}
