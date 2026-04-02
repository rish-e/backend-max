// =============================================================================
// backend-max — GraphQL security auditor
//
// Audits GraphQL schemas and resolvers for: introspection exposure,
// missing depth/complexity limits, N+1 patterns (DataLoader absence),
// missing field-level auth, and batching attack vectors.
// =============================================================================

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { glob } from "glob";
import type { Issue, IssueCategory } from "../types.js";
import { generateIssueId } from "../utils/helpers.js";

const CATEGORY: IssueCategory = "graphql";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphQLAuditResult {
  issues: Issue[];
  summary: {
    schemaFilesFound: number;
    resolverFilesFound: number;
    introspectionEnabled: boolean | null;
    hasDepthLimit: boolean;
    hasComplexityLimit: boolean;
    hasDataLoader: boolean;
    hasFieldAuth: boolean;
    graphqlPackage: string | null;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function auditGraphQL(projectPath: string): Promise<GraphQLAuditResult> {
  const issues: Issue[] = [];
  let schemaFilesFound = 0;
  let resolverFilesFound = 0;
  let introspectionEnabled: boolean | null = null;
  let hasDepthLimit = false;
  let hasComplexityLimit = false;
  let hasDataLoader = false;
  let hasFieldAuth = false;
  let graphqlPackage: string | null = null;

  // Check if GraphQL is used
  try {
    const pkg = JSON.parse(await readFile(`${projectPath}/package.json`, "utf-8"));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    if ("graphql" in allDeps) graphqlPackage = "graphql";
    if ("@apollo/server" in allDeps || "apollo-server" in allDeps || "apollo-server-express" in allDeps) {
      graphqlPackage = "apollo";
    }
    if ("graphql-yoga" in allDeps) graphqlPackage = "graphql-yoga";
    if ("mercurius" in allDeps) graphqlPackage = "mercurius";
    if ("type-graphql" in allDeps) graphqlPackage = "type-graphql";
    if ("@nestjs/graphql" in allDeps) graphqlPackage = "nestjs-graphql";
    if ("pothos" in allDeps || "@pothos/core" in allDeps) graphqlPackage = "pothos";

    // Check for security packages
    if ("graphql-depth-limit" in allDeps) hasDepthLimit = true;
    if ("graphql-query-complexity" in allDeps || "graphql-validation-complexity" in allDeps) hasComplexityLimit = true;
    if ("dataloader" in allDeps) hasDataLoader = true;
    if ("graphql-shield" in allDeps) hasFieldAuth = true;
  } catch {
    return {
      issues: [],
      summary: {
        schemaFilesFound: 0, resolverFilesFound: 0,
        introspectionEnabled: null, hasDepthLimit: false,
        hasComplexityLimit: false, hasDataLoader: false,
        hasFieldAuth: false, graphqlPackage: null,
      },
    };
  }

  if (!graphqlPackage) {
    return {
      issues: [],
      summary: {
        schemaFilesFound: 0, resolverFilesFound: 0,
        introspectionEnabled: null, hasDepthLimit: false,
        hasComplexityLimit: false, hasDataLoader: false,
        hasFieldAuth: false, graphqlPackage: null,
      },
    };
  }

  // Scan for schema and resolver files
  const allFiles = await glob("**/*.{ts,tsx,js,jsx,graphql,gql}", {
    cwd: projectPath,
    absolute: true,
    nodir: true,
    ignore: ["node_modules/**", ".next/**", "dist/**", "build/**"],
  });

  const schemaFiles: Array<{ path: string; content: string }> = [];
  const resolverFiles: Array<{ path: string; content: string }> = [];
  const serverFiles: Array<{ path: string; content: string }> = [];

  for (const filePath of allFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch { continue; }

    const relPath = relative(projectPath, filePath);

    // Schema files (.graphql, .gql, or type definitions)
    if (filePath.endsWith(".graphql") || filePath.endsWith(".gql")) {
      schemaFiles.push({ path: relPath, content });
      schemaFilesFound++;
    }
    // typeDefs inline
    if (content.includes("gql`") || content.includes("gql(") || content.includes("#graphql")) {
      schemaFiles.push({ path: relPath, content });
      schemaFilesFound++;
    }

    // Resolver files
    if (
      content.includes("Resolvers") ||
      content.includes("@Resolver") ||
      content.includes("resolvers") ||
      /Query\s*[:=]\s*\{/.test(content) ||
      /Mutation\s*[:=]\s*\{/.test(content)
    ) {
      resolverFiles.push({ path: relPath, content });
      resolverFilesFound++;
    }

    // Server setup files
    if (
      content.includes("ApolloServer") ||
      content.includes("createYoga") ||
      content.includes("mercurius") ||
      content.includes("GraphQLModule")
    ) {
      serverFiles.push({ path: relPath, content });
    }
  }

  // ── CHECK 1: Introspection in production ──
  for (const sf of serverFiles) {
    if (sf.content.includes("introspection")) {
      // Check if it's explicitly enabled
      if (/introspection\s*:\s*true/i.test(sf.content)) {
        introspectionEnabled = true;
        // Only flag if no production check
        if (!sf.content.includes("NODE_ENV") && !sf.content.includes("production")) {
          issues.push({
            id: generateIssueId(CATEGORY, sf.path, "introspection-enabled"),
            category: CATEGORY,
            severity: "warning",
            title: "GraphQL introspection enabled unconditionally",
            description:
              `Introspection is enabled in ${sf.path} without a production check. ` +
              "Attackers can query your entire schema. Disable in production: " +
              "`introspection: process.env.NODE_ENV !== 'production'`",
            file: sf.path,
            line: findLine(sf.content, /introspection/),
            status: "open",
            firstSeen: new Date().toISOString(),
            fixedAt: null,
          });
        }
      }
    } else if (graphqlPackage === "apollo") {
      // Apollo v4 disables introspection by default, but v3 and earlier enable it
      introspectionEnabled = null; // Unknown
    }
  }

  // ── CHECK 2: Query depth limiting ──
  if (!hasDepthLimit) {
    let foundInCode = false;
    for (const sf of serverFiles) {
      if (sf.content.includes("depthLimit") || sf.content.includes("depth-limit") || sf.content.includes("maxDepth")) {
        foundInCode = true;
        hasDepthLimit = true;
        break;
      }
    }
    if (!foundInCode) {
      issues.push({
        id: generateIssueId(CATEGORY, "package.json", "no-depth-limit"),
        category: CATEGORY,
        severity: "warning",
        title: "No GraphQL query depth limiting",
        description:
          "No depth limiting found. Deeply nested queries can cause DoS: " +
          "`{ user { friends { friends { friends ... } } } }`. " +
          "Install `graphql-depth-limit` and set a reasonable limit (e.g., 10).",
        file: "package.json",
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }
  }

  // ── CHECK 3: Query complexity limiting ──
  if (!hasComplexityLimit) {
    let foundInCode = false;
    for (const sf of serverFiles) {
      if (sf.content.includes("complexity") || sf.content.includes("costAnalysis") || sf.content.includes("cost-analysis")) {
        foundInCode = true;
        hasComplexityLimit = true;
        break;
      }
    }
    if (!foundInCode) {
      issues.push({
        id: generateIssueId(CATEGORY, "package.json", "no-complexity-limit"),
        category: CATEGORY,
        severity: "warning",
        title: "No GraphQL query complexity limiting",
        description:
          "No complexity/cost analysis found. Expensive queries (large list fetches, " +
          "multiple joins) can overload your server. Install `graphql-query-complexity` " +
          "and assign costs to fields.",
        file: "package.json",
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }
  }

  // ── CHECK 4: N+1 queries (DataLoader) ──
  if (!hasDataLoader) {
    // Check if resolvers have list fields that fetch related data
    let hasNestedResolvers = false;
    for (const rf of resolverFiles) {
      // Look for patterns like fetching inside a resolver for a list field
      if (
        (rf.content.includes("findMany") || rf.content.includes("find(") || rf.content.includes("SELECT")) &&
        (rf.content.includes("parent") || rf.content.includes("root") || rf.content.includes("source"))
      ) {
        hasNestedResolvers = true;
        issues.push({
          id: generateIssueId(CATEGORY, rf.path, "n+1-risk"),
          category: CATEGORY,
          severity: "warning",
          title: `Potential N+1 query in resolver — ${rf.path}`,
          description:
            "Resolver fetches data using parent/root context without DataLoader. " +
            "This causes N+1 database queries for list fields. " +
            "Install `dataloader` and batch-load related records.",
          file: rf.path,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
        break; // One warning is enough
      }
    }

    if (!hasNestedResolvers && resolverFilesFound > 0) {
      issues.push({
        id: generateIssueId(CATEGORY, "package.json", "no-dataloader"),
        category: CATEGORY,
        severity: "info",
        title: "DataLoader not installed",
        description:
          "The `dataloader` package is not installed. If you have nested GraphQL resolvers " +
          "that fetch related data, consider using DataLoader to prevent N+1 query issues.",
        file: "package.json",
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }
  }

  // ── CHECK 5: Field-level authorization ──
  if (!hasFieldAuth) {
    // Check for inline auth patterns in resolvers
    for (const rf of resolverFiles) {
      if (
        rf.content.includes("@Authorized") ||
        rf.content.includes("authorize") ||
        rf.content.includes("shield") ||
        rf.content.includes("isAdmin") ||
        rf.content.includes("checkPermission")
      ) {
        hasFieldAuth = true;
        break;
      }
    }

    // Check for mutations without auth
    for (const rf of resolverFiles) {
      if (
        (/Mutation/i.test(rf.content) || rf.content.includes("@Mutation")) &&
        !rf.content.includes("auth") &&
        !rf.content.includes("session") &&
        !rf.content.includes("token") &&
        !rf.content.includes("currentUser")
      ) {
        issues.push({
          id: generateIssueId(CATEGORY, rf.path, "mutation-no-auth"),
          category: CATEGORY,
          severity: "warning",
          title: `Mutation resolver without visible auth check — ${rf.path}`,
          description:
            "GraphQL mutation resolvers should verify authentication/authorization. " +
            "No auth check (session, token, currentUser) was found in this resolver file. " +
            "Consider using `graphql-shield` for declarative field-level permissions.",
          file: rf.path,
          line: findLine(rf.content, /Mutation/i),
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
        break;
      }
    }
  }

  // ── CHECK 6: Batching attacks ──
  for (const sf of serverFiles) {
    if (!sf.content.includes("allowBatchedHttpRequests") && !sf.content.includes("batching")) {
      // Check if batching is implicitly enabled
      if (graphqlPackage === "apollo") {
        issues.push({
          id: generateIssueId(CATEGORY, sf.path, "batching-uncontrolled"),
          category: CATEGORY,
          severity: "info",
          title: "GraphQL query batching not explicitly configured",
          description:
            "Query batching allows clients to send multiple queries in a single HTTP request. " +
            "If uncontrolled, this can bypass rate limiting (each batch counts as one request). " +
            "Set `allowBatchedHttpRequests: false` or limit batch size.",
          file: sf.path,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }
  }

  return {
    issues,
    summary: {
      schemaFilesFound,
      resolverFilesFound,
      introspectionEnabled,
      hasDepthLimit,
      hasComplexityLimit,
      hasDataLoader,
      hasFieldAuth,
      graphqlPackage,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLine(content: string, pattern: RegExp): number | null {
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;
  return content.slice(0, match.index).split("\n").length;
}
