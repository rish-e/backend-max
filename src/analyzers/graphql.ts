// =============================================================================
// backend-max — GraphQL resolver analyzer
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
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

/** GraphQL packages we look for. */
const GRAPHQL_PACKAGES = [
  "graphql",
  "@apollo/server",
  "apollo-server",
  "apollo-server-express",
  "apollo-server-micro",
  "@apollo/server-integration-next",
  "mercurius",
  "graphql-yoga",
  "type-graphql",
  "nexus",
  "@pothos/core",
];

/** Patterns indicating resolver definitions. */
const RESOLVER_PATTERNS = [
  /Query\s*:\s*\{/,
  /Mutation\s*:\s*\{/,
  /Subscription\s*:\s*\{/,
  /resolvers?\s*[:=]\s*\{/,
  /createResolvers/,
  /@Resolver\s*\(/,
  /@Query\s*\(/,
  /@Mutation\s*\(/,
];

/** Pattern for DataLoader usage (N+1 prevention). */
const _DATALOADER_REGEX = /DataLoader|dataloader|\.load\s*\(|\.loadMany\s*\(/i;

// ---------------------------------------------------------------------------
// GraphQL Analyzer
// ---------------------------------------------------------------------------

/**
 * Creates a GraphQL framework analyzer implementing FrameworkAnalyzer.
 */
export function createGraphQLAnalyzer(): FrameworkAnalyzer {
  return {
    name: "graphql",
    detect,
    scanRoutes: scanGraphQLRoutes,
    getFrameworkChecks,
  };
}

/**
 * Detect if GraphQL is used by checking package.json.
 */
async function detect(projectPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    const allDeps = { ...deps, ...devDeps };
    return GRAPHQL_PACKAGES.some((p) => p in allDeps);
  } catch {
    /* skip: unreadable/unparseable package.json */
    return false;
  }
}

/**
 * Scan all GraphQL resolvers and map them to RouteInfo.
 */
async function scanGraphQLRoutes(projectPath: string): Promise<RouteInfo[]> {
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
      "**/generated/**",
      "**/__generated__/**",
    ],
  });

  // Find files containing resolver definitions
  const resolverFiles: Array<{ filePath: string; content: string }> = [];

  for (const filePath of sourceFiles) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (RESOLVER_PATTERNS.some((p) => p.test(content))) {
        resolverFiles.push({ filePath, content });
      }
    } catch {
      /* skip: unreadable file */
    }
  }

  if (resolverFiles.length === 0) {
    return [];
  }

  const project = createProject(projectPath);
  const allRoutes: RouteInfo[] = [];

  for (const { filePath, content } of resolverFiles) {
    try {
      const routes = analyzeGraphQLFile(filePath, content, project);
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
 * Analyzes a single file for GraphQL resolver definitions.
 */
function analyzeGraphQLFile(filePath: string, content: string, project: Project): RouteInfo[] {
  let sourceFile: SourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(filePath);
  } catch {
    /* skip: unreadable/unparseable file */
    return [];
  }

  const routes: RouteInfo[] = [];

  // Extract resolvers from object literal pattern:
  // const resolvers = { Query: { ... }, Mutation: { ... } }
  const resolverSections = extractResolverSections(content);

  for (const section of resolverSections) {
    for (const resolver of section.resolvers) {
      const operationType = section.type;
      const httpMethod = operationType === "Mutation" ? "POST" : "GET";
      const url = `/graphql/${operationType.toLowerCase()}/${resolver.name}`;

      // Try to find the resolver node in the AST
      const resolverNode = findResolverNode(sourceFile, section.type, resolver.name);

      const methodInfo: MethodInfo = {
        method: httpMethod,
        hasValidation: resolverNode
          ? detectValidation(resolverNode)
          : /\.parse\s*\(|z\.\w+|zod|yup\.|joi\./i.test(resolver.bodyText),
        hasErrorHandling: resolverNode
          ? detectErrorHandling(resolverNode)
          : /try\s*\{/.test(resolver.bodyText),
        hasDatabaseCalls: resolverNode
          ? detectDatabaseCalls(resolverNode).length > 0
          : /prisma\.|db\.|knex|kysely|typeorm|sequelize|mongoose/i.test(resolver.bodyText),
        hasAuth: resolverNode
          ? detectAuthPatterns(resolverNode)
          : PROTECTED_RESOLVER_REGEX.test(resolver.bodyText),
        returnType: null,
        databaseCalls: resolverNode
          ? detectDatabaseCalls(resolverNode)
          : extractDbCallsFromText(resolver.bodyText),
        lineNumber: resolver.line,
      };

      routes.push({
        filePath,
        url,
        methods: [methodInfo],
        dynamicParams: [],
      });
    }
  }

  // Also check for decorator-based resolvers (type-graphql / @nestjs/graphql)
  const decoratorResolvers = extractDecoratorResolvers(sourceFile);
  for (const resolver of decoratorResolvers) {
    const httpMethod = resolver.type === "Mutation" ? "POST" : "GET";
    const url = `/graphql/${resolver.type.toLowerCase()}/${resolver.name}`;

    const methodInfo: MethodInfo = {
      method: httpMethod,
      hasValidation: resolver.hasValidation,
      hasErrorHandling: resolver.hasErrorHandling,
      hasDatabaseCalls: resolver.databaseCalls.length > 0,
      hasAuth: resolver.hasAuth,
      returnType: null,
      databaseCalls: resolver.databaseCalls,
      lineNumber: resolver.line,
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

/** Pattern for auth checks in resolvers. */
const PROTECTED_RESOLVER_REGEX =
  /context\.user|context\.session|requireAuth|isAuthenticated|authorize|@Authorized|@UseGuards/i;

/** Extracted resolver section info. */
interface ResolverSection {
  type: "Query" | "Mutation" | "Subscription";
  resolvers: Array<{
    name: string;
    bodyText: string;
    line: number;
  }>;
}

/**
 * Extracts resolver sections (Query, Mutation, Subscription) from file content.
 */
function extractResolverSections(content: string): ResolverSection[] {
  const sections: ResolverSection[] = [];
  const types = ["Query", "Mutation", "Subscription"] as const;

  for (const type of types) {
    const regex = new RegExp(`${type}\\s*:\\s*\\{`, "g");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const startIdx = match.index + match[0].length;
      const sectionEnd = findMatchingBrace(content, startIdx - 1);
      if (sectionEnd === -1) continue;

      const sectionContent = content.slice(startIdx, sectionEnd);
      const resolvers = extractResolversFromSection(
        sectionContent,
        content.slice(0, startIdx).split("\n").length,
      );

      sections.push({ type, resolvers });
    }
  }

  return sections;
}

/**
 * Finds the matching closing brace for an opening brace.
 */
function findMatchingBrace(text: string, startIdx: number): number {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts individual resolver functions from a Query/Mutation section.
 */
function extractResolversFromSection(
  sectionContent: string,
  baseLineNumber: number,
): Array<{ name: string; bodyText: string; line: number }> {
  const resolvers: Array<{ name: string; bodyText: string; line: number }> = [];

  // Match patterns like: resolverName: async (parent, args, context) => { ... }
  // or: resolverName(parent, args, context) { ... }
  // or: async resolverName(parent, args, context) { ... }
  const resolverRegex = /(?:async\s+)?(\w+)\s*(?::\s*(?:async\s*)?\(|[(])/g;

  let match: RegExpExecArray | null;
  while ((match = resolverRegex.exec(sectionContent)) !== null) {
    const name = match[1];
    // Skip common non-resolver names
    if (
      ["async", "function", "return", "const", "let", "var", "if", "else", "try", "catch"].includes(
        name,
      )
    )
      continue;

    const lineOffset = sectionContent.slice(0, match.index).split("\n").length - 1;
    const startIdx = match.index;

    // Find the resolver body end
    const bodyStart = sectionContent.indexOf("{", startIdx);
    if (bodyStart === -1) continue;

    const bodyEnd = findMatchingBrace(sectionContent, bodyStart);
    if (bodyEnd === -1) continue;

    const bodyText = sectionContent.slice(startIdx, bodyEnd + 1);

    resolvers.push({
      name,
      bodyText,
      line: baseLineNumber + lineOffset,
    });
  }

  return resolvers;
}

/** Decorator-based resolver info. */
interface DecoratorResolver {
  name: string;
  type: "Query" | "Mutation";
  hasValidation: boolean;
  hasErrorHandling: boolean;
  hasAuth: boolean;
  databaseCalls: string[];
  line: number;
}

/**
 * Extracts decorator-based resolvers (@Query, @Mutation from type-graphql/NestJS).
 */
function extractDecoratorResolvers(sourceFile: SourceFile): DecoratorResolver[] {
  const resolvers: DecoratorResolver[] = [];

  for (const cls of sourceFile.getClasses()) {
    for (const method of cls.getMethods()) {
      const decorators = method.getDecorators();
      let type: "Query" | "Mutation" | null = null;

      for (const dec of decorators) {
        const decName = dec.getName();
        if (decName === "Query") type = "Query";
        else if (decName === "Mutation") type = "Mutation";
      }

      if (!type) continue;

      const hasAuth =
        decorators.some((d) => d.getName() === "Authorized" || d.getName() === "UseGuards") ||
        detectAuthPatterns(method);

      resolvers.push({
        name: method.getName(),
        type,
        hasValidation: detectValidation(method),
        hasErrorHandling: detectErrorHandling(method),
        hasAuth,
        databaseCalls: detectDatabaseCalls(method),
        line: method.getStartLineNumber(),
      });
    }
  }

  return resolvers;
}

/**
 * Finds a resolver's AST node within a Query/Mutation object.
 */
function findResolverNode(
  sourceFile: SourceFile,
  sectionType: string,
  resolverName: string,
): Node | null {
  const properties = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);

  for (const prop of properties) {
    if (prop.getName() === resolverName) {
      // Verify it's inside a Query/Mutation section
      let parent: Node | undefined = prop.getParent();
      while (parent) {
        if (Node.isPropertyAssignment(parent) && parent.getName() === sectionType) {
          return prop;
        }
        parent = parent.getParent();
      }
      // If we can't verify nesting, return it anyway as likely match
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
      id: "graphql-n-plus-one",
      name: "Potential N+1 query in resolver",
      description:
        "Resolvers that make database calls for related data should use DataLoader to batch requests and prevent N+1 query problems.",
      check: checkNPlusOne,
    },
    {
      id: "graphql-unprotected-mutation",
      name: "Unprotected GraphQL mutation",
      description:
        "GraphQL mutations that modify data should include authentication/authorization checks.",
      check: checkUnprotectedMutations,
    },
    {
      id: "graphql-missing-error-handling",
      name: "Resolver without error handling",
      description:
        "Resolvers with database calls should have error handling to return proper GraphQL errors.",
      check: checkResolverErrorHandling,
    },
    {
      id: "graphql-missing-input-validation",
      name: "Mutation without input validation",
      description: "GraphQL mutations should validate their input arguments before processing.",
      check: checkMissingInputValidation,
    },
  ];
}

async function checkNPlusOne(projectPath: string, routes: RouteInfo[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();

  // Check if DataLoader is used in the project
  let hasDataLoader = false;
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    hasDataLoader = "dataloader" in deps;
  } catch {
    /* skip: unreadable/unparseable package.json */
  }

  for (const route of routes) {
    if (!route.url.startsWith("/graphql/")) continue;

    for (const method of route.methods) {
      if (method.hasDatabaseCalls && !hasDataLoader) {
        // Check if any database call looks like a related-data fetch
        const hasRelatedFetch = method.databaseCalls.some((call) =>
          /find(?:Many|First|Unique)|select|where/i.test(call),
        );
        if (hasRelatedFetch) {
          issues.push({
            id: "",
            category: "performance",
            severity: "warning",
            title: `Potential N+1 query in resolver: ${route.url}`,
            description:
              "This resolver makes database calls but the project doesn't use DataLoader. Consider adding dataloader to batch and cache database requests.",
            file: route.filePath,
            line: method.lineNumber,
            status: "open",
            firstSeen: timestamp,
            fixedAt: null,
          });
        }
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
    if (!route.url.startsWith("/graphql/mutation/")) continue;

    for (const method of route.methods) {
      if (!method.hasAuth) {
        issues.push({
          id: "",
          category: "auth",
          severity: "warning",
          title: `Unprotected GraphQL mutation: ${route.url}`,
          description:
            "This mutation does not check authentication. Add auth checks via context or @Authorized decorator.",
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

async function checkResolverErrorHandling(
  _projectPath: string,
  routes: RouteInfo[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();

  for (const route of routes) {
    if (!route.url.startsWith("/graphql/")) continue;

    for (const method of route.methods) {
      if (method.hasDatabaseCalls && !method.hasErrorHandling) {
        issues.push({
          id: "",
          category: "error-handling",
          severity: "warning",
          title: `GraphQL resolver without error handling: ${route.url}`,
          description:
            "This resolver makes database calls but has no error handling. Wrap in try/catch and throw GraphQLError or ApolloError.",
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

async function checkMissingInputValidation(
  _projectPath: string,
  routes: RouteInfo[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const timestamp = new Date().toISOString();

  for (const route of routes) {
    if (!route.url.startsWith("/graphql/mutation/")) continue;

    for (const method of route.methods) {
      if (!method.hasValidation && method.hasDatabaseCalls) {
        issues.push({
          id: "",
          category: "validation",
          severity: "warning",
          title: `GraphQL mutation without input validation: ${route.url}`,
          description:
            "This mutation writes to the database but doesn't validate input arguments. Add runtime validation for args before processing.",
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
