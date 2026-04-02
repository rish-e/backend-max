#!/usr/bin/env node

/**
 * Backend Max — MCP Server
 *
 * The AI-powered backend diagnostic that understands what you're building
 * and makes sure it actually works.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runSafetyChecks } from "./safety/index.js";
import { buildApiGraph, queryApiGraph } from "./tools/api-graph.js";
import { auditApiVersioning } from "./tools/api-versioning-auditor.js";
import { getContext, initContext, updateContext } from "./tools/context-manager.js";
import { checkContracts } from "./tools/contract-checker.js";
import { scanDependencies } from "./tools/dep-scanner.js";
import { generateDocs } from "./tools/doc-generator.js";
import { scanEnvVars } from "./tools/env-scanner.js";
import { auditErrorHandling } from "./tools/error-auditor.js";
import { fixAllIssues, fixIssue } from "./tools/fix-engine.js";
import { getLedger } from "./tools/ledger-manager.js";
import { runLiveTests } from "./tools/live-tester.js";
import { visualizeMiddleware } from "./tools/middleware-visualizer.js";
import { runFullDiagnosis } from "./tools/orchestrator.js";
import { getCommonPatterns } from "./tools/pattern-tracker.js";
import { auditPerformance } from "./tools/performance-auditor.js";
import { auditPrisma } from "./tools/prisma-auditor.js";
import { auditRateLimitAndCaching } from "./tools/rate-limit-auditor.js";
import { scanRoutes } from "./tools/route-scanner.js";
import { auditSecurity } from "./tools/security-auditor.js";
import { auditServerActions } from "./tools/server-actions-auditor.js";
import { traceTypes } from "./tools/type-tracer.js";
import { getChangesSummary, runIncrementalAnalysis } from "./tools/watcher.js";
import { auditSecrets } from "./tools/secrets-auditor.js";
import { auditExternal } from "./tools/external-auditor.js";
import { auditBreakingChanges } from "./tools/breaking-changes-auditor.js";
import { auditMigrations } from "./tools/migration-auditor.js";
import { auditGraphQL } from "./tools/graphql-auditor.js";
import { scoreTechDebt } from "./tools/tech-debt-scorer.js";
import type { ApiGraph } from "./types.js";

const server = new McpServer(
  {
    name: "backend-max",
    version: "2.2.0",
  },
  {
    capabilities: { logging: {} },
    instructions: `Backend Max is an AI-powered backend diagnostic tool. It understands what the user is building and verifies the backend works correctly.

Key workflow:
1. Always run "init_context" first if no context exists — this understands the project
2. Use "run_diagnosis" for a full health check
3. Use individual audit tools for targeted checks
4. Use "get_api_docs" to read the living documentation
5. Use "fix_issue" to apply proposed fixes

The tool only analyzes backend code. It never modifies frontend/UI code.`,
  },
);

// ─── Core Orchestration ──────────────────────────────────────────────

server.tool(
  "run_diagnosis",
  "Run a full backend diagnosis — scans routes, checks contracts, audits errors, env vars, security, and performance. Generates documentation and updates the issue ledger. This is the main entry point.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    focus: z
      .enum([
        "all",
        "routes",
        "contracts",
        "errors",
        "env",
        "security",
        "performance",
        "prisma",
        "server-actions",
        "dependencies",
        "rate-limiting",
        "versioning",
        "middleware",
        "secrets",
        "migrations",
        "graphql",
      ])
      .default("all")
      .describe("Focus area for the diagnosis (default: all)"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath, focus }) => {
    try {
      const result = await runFullDiagnosis(projectPath, focus);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Diagnosis failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Project Context ─────────────────────────────────────────────────

server.tool(
  "init_context",
  "Analyze a project for the first time to understand what it does. Scans routes, package.json, database schema, and README to build a project understanding. Run this before any diagnosis.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath }) => {
    try {
      const context = await initContext(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Context init failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "update_context",
  "Update the project understanding with user-provided corrections or additions.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    updates: z
      .object({
        description: z.string().optional(),
        domains: z.array(z.string()).optional(),
        notes: z.array(z.string()).optional(),
      })
      .describe("Updates to apply to the project context"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath, updates }) => {
    try {
      const context = await updateContext(projectPath, updates);
      return {
        content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Context update failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_context",
  "Get the current project understanding.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const context = await getContext(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
      };
    } catch (_error) {
      return {
        content: [
          {
            type: "text",
            text: `No project context found. Run init_context first.`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Individual Audit Tools ──────────────────────────────────────────

server.tool(
  "scan_routes",
  "Scan and parse all API routes in a Next.js project. Returns the full API surface: endpoints, HTTP methods, parameters, and file locations.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const routes = await scanRoutes(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(routes, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Route scan failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "check_contracts",
  "Verify frontend-backend contracts. Finds all API calls in frontend code and cross-references them against backend route definitions. Detects mismatches, dead endpoints, and phantom calls.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await checkContracts(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Contract check failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_errors",
  "Audit error handling across all API routes. Checks for try/catch coverage, consistent error response formats, unhandled promise rejections, and missing global error handlers.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditErrorHandling(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_env",
  "Scan environment variable usage. Cross-references process.env references against .env files, checks for missing NEXT_PUBLIC_ prefixes, and detects undefined variables.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await scanEnvVars(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Env audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_security",
  "Check security posture. Detects auth middleware gaps, CORS misconfigurations, missing input validation, and known vulnerability patterns.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditSecurity(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Security audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_performance",
  "Detect performance anti-patterns. Finds N+1 queries, unbounded database calls, missing pagination, and payload bloat (backend returns more data than frontend uses).",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditPerformance(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Performance audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_prisma",
  "Audit Prisma schema and database usage. Parses schema.prisma, cross-references database calls against the schema to find nonexistent models/fields, suggests missing indexes, and checks for migration drift.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditPrisma(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Prisma audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_server_actions",
  "Audit Next.js Server Actions. Finds all 'use server' functions and checks for missing validation, error handling, auth checks, and unprotected database calls.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditServerActions(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Server actions audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Documentation & History ─────────────────────────────────────────

server.tool(
  "get_api_docs",
  "Get the auto-generated living API documentation for the project. Returns the full route map with request/response types, auth requirements, and frontend consumers.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const docs = await generateDocs(projectPath);
      return {
        content: [{ type: "text", text: docs }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Doc generation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_ledger",
  "Get the issue ledger — tracks every issue from discovery through fix. Filter by status, severity, or category.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    filter: z
      .object({
        status: z.enum(["all", "open", "fixed", "ignored", "regressed"]).default("all"),
        severity: z.enum(["all", "critical", "warning", "info"]).default("all"),
        category: z.string().optional(),
      })
      .default({ status: "all", severity: "all" })
      .describe("Filter criteria for ledger entries"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath, filter }) => {
    try {
      const ledger = await getLedger(projectPath, filter);
      return {
        content: [{ type: "text", text: JSON.stringify(ledger, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Ledger read failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Fix Engine ──────────────────────────────────────────────────────

server.tool(
  "fix_issue",
  "Apply a proposed fix for a specific issue. Only fixes backend code — never touches frontend files.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    issueId: z.string().describe("The issue ID to fix (e.g., CTR-001)"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath, issueId }) => {
    try {
      const result = await fixIssue(projectPath, issueId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fix failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Safety ──────────────────────────────────────────────────────────

server.tool(
  "run_safety_check",
  "Run safety validation on a project path. Validates the path is safe to scan, ensures .backend-doctor/ is in .gitignore, and prunes old reports. Call this before any diagnosis to verify the project is safe to analyze.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await runSafetyChecks(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Safety check failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Live Testing ────────────────────────────────────────────────────

server.tool(
  "live_test",
  "Run live HTTP tests against discovered API endpoints. SAFETY: Only GET endpoints are tested. DELETE is never called. POST/PUT/PATCH are skipped (no safe payload generation). Only localhost URLs are accepted.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    baseUrl: z.string().describe('Base URL of the running server (e.g., "http://localhost:3000")'),
    timeout: z
      .number()
      .default(5000)
      .describe("Per-request timeout in milliseconds (default: 5000)"),
    includeAuth: z
      .boolean()
      .default(false)
      .describe("Whether to test endpoints that require authentication"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("If true, show what would be tested without making HTTP calls"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ projectPath, baseUrl, timeout, includeAuth, dryRun }) => {
    try {
      const result = await runLiveTests(projectPath, {
        baseUrl,
        timeout,
        includeAuth,
        dryRun,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Live test failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── API Graph ───────────────────────────────────────────────────────

/** Cache for API graphs to avoid rebuilding on repeated queries. */
const graphCache = new Map<string, ApiGraph>();

server.tool(
  "query_api",
  'Query the API graph with natural language. Builds a graph of routes, models, frontend components, and middleware, then queries it. Examples: "unprotected routes", "routes that write to users", "unused models".',
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    query: z
      .string()
      .describe(
        'Natural language query (e.g., "unprotected routes", "routes that write to users")',
      ),
    rebuild: z
      .boolean()
      .default(false)
      .describe("Force rebuild the API graph (default: use cache)"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath, query, rebuild }) => {
    try {
      let graph = graphCache.get(projectPath);
      if (!graph || rebuild) {
        graph = await buildApiGraph(projectPath);
        // Simple eviction — clear all when too many entries
        if (graphCache.size > 50) {
          graphCache.clear();
        }
        graphCache.set(projectPath, graph);
      }

      const result = queryApiGraph(graph, query);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `API graph query failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Pattern Tracking ────────────────────────────────────────────────

server.tool(
  "get_patterns",
  "Get common patterns across projects. Shows the most frequently encountered issues for a given framework. Data is stored locally only — never sent externally.",
  {
    framework: z
      .string()
      .default("all")
      .describe('Framework to filter by (e.g., "nextjs", "express", or "all")'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ framework }) => {
    try {
      const patterns = await getCommonPatterns(framework);
      if (patterns.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No patterns tracked yet. Patterns are collected automatically after each diagnosis (opt-in).",
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(patterns, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Pattern retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Fix All Issues ─────────────────────────────────────────────

server.tool(
  "fix_all_issues",
  "Generate code patches for all open issues in the ledger. Returns unified diffs that can be applied with git apply. Does NOT auto-apply — returns patches for review.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const results = await fixAllIssues(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fix all failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Watch Mode / Incremental Analysis ──────────────────────────

server.tool(
  "watch_diagnosis",
  "Run an incremental diagnosis — compares current state against the last saved report. Highlights new issues, fixed issues, and health score changes. Runs a full analysis but highlights what changed — new issues, fixed issues, and health score delta.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    focus: z
      .enum([
        "all",
        "routes",
        "contracts",
        "errors",
        "env",
        "security",
        "performance",
        "prisma",
        "server-actions",
        "dependencies",
        "rate-limiting",
        "versioning",
        "middleware",
        "secrets",
        "migrations",
        "graphql",
      ])
      .default("all")
      .describe("Focus area for the diagnosis (default: all)"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath, focus }) => {
    try {
      const result = await runIncrementalAnalysis(projectPath, focus);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Watch diagnosis failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "check_changes",
  "Quick check — shows which files changed since the last diagnosis and how long ago it ran. Does NOT re-run analysis. Use this to decide if a full re-run is needed.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await getChangesSummary(projectPath);
      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: "No previous diagnosis found. Run run_diagnosis first to establish a baseline.",
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Change check failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Dependency Scanner ─────────────────────────────────────────

server.tool(
  "scan_dependencies",
  "Scan project dependencies for known vulnerabilities, deprecated packages, and security issues. Checks package.json against a built-in vulnerability database and optionally runs npm audit. No network required for basic checks.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await scanDependencies(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Dependency scan failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Rate Limiting & Caching Audit ───────────────────────────────

server.tool(
  "audit_rate_limiting",
  "Audit rate limiting and caching patterns. Detects rate limiting packages and code patterns, finds auth endpoints without rate limiting, identifies GET endpoints with DB calls but no caching, and flags cacheable endpoints missing Cache-Control headers.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditRateLimitAndCaching(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Rate limit audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── API Versioning Audit ───────────────────────────────────────

server.tool(
  "audit_versioning",
  "Detect and audit API versioning patterns. Finds path-based (/v1/, /v2/) and header-based (X-API-Version) versioning, identifies version gaps (routes in v1 but not v2), and flags inconsistent versioning across endpoints.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await auditApiVersioning(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Versioning audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Middleware Chain Visualization ──────────────────────────────

server.tool(
  "visualize_middleware",
  "Visualize the middleware chain for all routes. Detects global middleware (app.use), Next.js middleware, and inline middleware. Shows execution order, identifies ordering issues (CORS before auth), and flags unprotected mutation endpoints.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await visualizeMiddleware(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Middleware visualization failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Secrets Auditor ──────────────────────────────────────────────

server.tool(
  "audit_secrets",
  "Scan codebase for hardcoded API keys, tokens, passwords, private keys, and connection strings. Uses pattern matching for 25+ provider-specific secret formats (AWS, Stripe, GitHub, OpenAI, Anthropic, etc.) and checks .gitignore for env file exclusion.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath }) => {
    try {
      const result = await auditSecrets(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Secrets audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── External / Remote Auditor ───────────────────────────────────

server.tool(
  "audit_external",
  "Audit a deployed website or API from the outside — checks security headers (HSTS, CSP, X-Frame-Options, etc.), server information leakage, caching configuration, HTTPS redirect, error page information disclosure, and response time. No source code needed.",
  {
    url: z.string().describe("The URL to audit (e.g., https://example.com)"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ url }) => {
    try {
      const result = await auditExternal(url);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `External audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Breaking Change Detector ────────────────────────────────────

server.tool(
  "audit_breaking_changes",
  "Compare current API routes against a saved baseline to detect breaking changes: removed endpoints, removed methods, changed parameters, removed validation or auth. Saves a baseline on first run.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
    saveBaseline: z.boolean().default(false).describe("If true, saves the current state as the new baseline after comparison"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath, saveBaseline }) => {
    try {
      const result = await auditBreakingChanges(projectPath, saveBaseline);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Breaking changes audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Migration Auditor ───────────────────────────────────────────

server.tool(
  "audit_migrations",
  "Audit database migration files for destructive operations (DROP TABLE, DROP COLUMN, type changes), missing rollback/down migrations, and schema drift. Supports Prisma, Knex, Drizzle, TypeORM, and raw SQL.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath }) => {
    try {
      const result = await auditMigrations(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Migration audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── GraphQL Security Auditor ────────────────────────────────────

server.tool(
  "audit_graphql",
  "Deep GraphQL security audit — checks for introspection exposure, missing query depth/complexity limits, N+1 query patterns (DataLoader absence), missing field-level authorization, and batching attack vectors. Supports Apollo, Yoga, Mercurius, NestJS, and Pothos.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath }) => {
    try {
      const result = await auditGraphQL(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `GraphQL audit failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Technical Debt Scorer ───────────────────────────────────────

server.tool(
  "score_tech_debt",
  "Calculate a technical debt score (0–100) from all audit findings. Estimates remediation effort in hours per category, assigns a letter grade (A+ to F), tracks score over time, and generates prioritized recommendations. Run after run_diagnosis for best results.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ projectPath }) => {
    try {
      // Run a full diagnosis first to get all issues
      const diagResult = await runFullDiagnosis(projectPath, "all");
      const result = await scoreTechDebt(projectPath, diagResult.issues);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Tech debt scoring failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Multi-Layer Type Tracing ────────────────────────────────────

server.tool(
  "trace_types",
  "Trace types across application layers: frontend → route handler → service → repository → database. Finds type mismatches between layers, identifies routes accessing DB directly without service layer, and maps the full type chain for each endpoint.",
  {
    projectPath: z.string().describe("Absolute path to the project root directory"),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ projectPath }) => {
    try {
      const result = await traceTypes(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Type tracing failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Prompts (slash commands for MCP clients) ──────────────────────

server.prompt(
  "backendmax",
  "Run Backend Max — full deep-dive backend diagnosis. Analyzes routes, contracts, security, performance, middleware, rate limiting, type tracing, and more. Pass your request as the argument.",
  {
    request: z
      .string()
      .optional()
      .describe(
        "What you want Backend Max to do (e.g., 'run a full diagnosis', 'check security', 'fix all issues')",
      ),
  },
  ({ request }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: BACKENDMAX_PROMPT.replace(
            "$REQUEST",
            request || "Run a full diagnosis on my project and tell me what needs fixing",
          ),
        },
      },
    ],
  }),
);

server.prompt(
  "backend-security",
  "Deep security audit — auth gaps, rate limiting, CORS, injection patterns, middleware ordering, unprotected endpoints.",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: SECURITY_PROMPT,
        },
      },
    ],
  }),
);

server.prompt(
  "backend-fix",
  "Generate code patches for all open backend issues. Returns unified diffs you can review and apply.",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: FIX_PROMPT,
        },
      },
    ],
  }),
);

// ─── Prompt templates ───────────────────────────────────────────────

const BACKENDMAX_PROMPT = `You have access to the Backend Max MCP server with 27 backend diagnostic tools. The user's request is:

> $REQUEST

## Instructions

Based on what the user asked, follow the right approach:

### Full Diagnosis (default if unclear)
1. Call \`init_context\` with the project path to understand the project
2. Call \`run_diagnosis\` with \`focus: "all"\` to run every audit engine
3. Present results clearly:
   - Health score with visual indicator (90+: excellent, 80+: good, 60+: needs work, <60: critical)
   - Critical issues first — these need immediate attention
   - Warnings grouped by category
   - Info items as suggestions
4. For each critical/warning issue, explain WHY it matters and suggest the fix

### Targeted Analysis
Route the request to the right tool:
- Routes/endpoints → scan_routes
- Frontend↔backend contracts → check_contracts
- Error handling → audit_errors
- Environment variables → audit_env
- Security → audit_security
- Performance → audit_performance
- Prisma/database → audit_prisma
- Server actions → audit_server_actions
- Dependencies/vulnerabilities → scan_dependencies
- Rate limiting & caching → audit_rate_limiting
- API versioning → audit_versioning
- Middleware chains → visualize_middleware
- Type tracing (frontend→DB) → trace_types
- API documentation → get_api_docs
- Issue history → get_ledger
- What changed → check_changes / watch_diagnosis

### Fixing Issues
1. Run diagnosis first if no recent results
2. Use fix_issue or fix_all_issues to generate patches
3. Show the generated patches and explain each fix
4. Ask if the user wants you to apply them

## Project Path
Use the current working directory. If it has a package.json, that's the project root.

## Response Format
**Project:** {name} ({framework})
**Health Score:** {score}/100

Then present findings by severity with actionable explanations — exact files, line numbers, and what to change.`;

const SECURITY_PROMPT = `Run a deep security audit on my backend project using Backend Max.

1. Call \`init_context\` to understand the project
2. Run these tools in sequence and combine the results:
   - \`audit_security\` — auth gaps, CORS, injection patterns, exposed secrets
   - \`audit_rate_limiting\` — rate limiting coverage, unprotected auth endpoints, caching gaps
   - \`visualize_middleware\` — middleware ordering issues, unprotected mutation endpoints
   - \`scan_dependencies\` — known vulnerabilities, deprecated packages
3. Present a unified security report:
   - Critical vulnerabilities first
   - Auth coverage analysis (which endpoints are protected, which aren't)
   - Rate limiting coverage
   - Middleware chain issues
   - Dependency risks
4. For each finding, explain the attack vector and how to fix it`;

const FIX_PROMPT = `Generate code fixes for all open issues in my backend project.

1. Call \`init_context\` to understand the project
2. Call \`run_diagnosis\` with focus "all" to find all current issues
3. Call \`fix_all_issues\` to generate unified diff patches
4. Present each fix:
   - What issue it solves
   - The diff/patch
   - Why this fix is correct
5. Ask if I want you to apply the patches`;

// ─── Start Server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // Best-effort cleanup
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
