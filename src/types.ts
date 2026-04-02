// =============================================================================
// backend-max — Shared type definitions
// =============================================================================

/** Severity levels for issues discovered during analysis. */
export type Severity = "critical" | "bug" | "warning" | "info";

/** Lifecycle status of a tracked issue. */
export type IssueStatus = "open" | "fixed" | "ignored" | "regressed";

/** Categories that an issue can belong to. */
export type IssueCategory =
  | "contract"
  | "contract-type-mismatch"
  | "error-handling"
  | "validation"
  | "env"
  | "security"
  | "performance"
  | "nextjs"
  | "express"
  | "auth"
  | "prisma"
  | "server-actions"
  | "trpc"
  | "graphql"
  | "dependency"
  | "fastify"
  | "hono"
  | "rate-limit"
  | "caching"
  | "versioning"
  | "middleware"
  | "secrets"
  | "migrations"
  | "tech-debt";

// ---------------------------------------------------------------------------
// Route scanning
// ---------------------------------------------------------------------------

/** Information about a single exported HTTP method handler. */
export interface MethodInfo {
  /** HTTP method name (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS). */
  method: string;
  /** Whether the handler uses a validation library (Zod, Yup, Joi, etc.). */
  hasValidation: boolean;
  /** Whether the handler wraps logic in try/catch. */
  hasErrorHandling: boolean;
  /** Whether the handler contains database calls (Prisma, Drizzle, etc.). */
  hasDatabaseCalls: boolean;
  /** Whether the handler uses authentication / middleware patterns. */
  hasAuth: boolean;
  /** TypeScript return type annotation, if present. */
  returnType: string | null;
  /** List of database call expressions found (e.g. "prisma.user.findMany"). */
  databaseCalls: string[];
  /** Line number where the handler is defined. */
  lineNumber: number;
}

/** Information about a single route file. */
export interface RouteInfo {
  /** Absolute path to the route file. */
  filePath: string;
  /** HTTP URL pattern derived from the file path (e.g. "/api/users/[id]"). */
  url: string;
  /** Exported HTTP method handlers found in this file. */
  methods: MethodInfo[];
  /** Dynamic parameter names extracted from the URL pattern. */
  dynamicParams: string[];
}

/** Result returned by the route scanner. */
export interface ScanResult {
  /** All discovered route files with their handlers. */
  routes: RouteInfo[];
  /** High-level summary of the scan. */
  summary: {
    totalRoutes: number;
    totalEndpoints: number;
    frameworksDetected: string[];
  };
}

// ---------------------------------------------------------------------------
// Frontend call detection
// ---------------------------------------------------------------------------

/** A fetch/axios call discovered in frontend code. */
export interface FrontendCall {
  /** The URL string or pattern being called. */
  url: string;
  /** HTTP method (GET, POST, etc.) — defaults to GET when not specified. */
  method: string;
  /** File where the call was found. */
  file: string;
  /** Line number of the call. */
  line: number;
  /** Expected response type, if extractable. */
  expectedType: string | null;
}

// ---------------------------------------------------------------------------
// Contract analysis
// ---------------------------------------------------------------------------

/** A mismatch between a frontend call and a backend route. */
export interface ContractMismatch {
  /** The frontend call that doesn't match a backend route. */
  frontendCall: FrontendCall;
  /** The closest matching route, if any. */
  closestRoute: RouteInfo | null;
  /** Human-readable description of the mismatch. */
  reason: string;
  /** Severity of the mismatch. */
  severity: Severity;
}

/** Result of a full contract analysis. */
export interface ContractResult {
  /** All detected mismatches. */
  mismatches: ContractMismatch[];
  /** Number of frontend calls that matched a backend route. */
  matchedCount: number;
  /** Number of frontend calls that did NOT match. */
  unmatchedCount: number;
}

// ---------------------------------------------------------------------------
// Issue tracking / ledger
// ---------------------------------------------------------------------------

/** A single issue found during diagnosis. */
export interface Issue {
  /** Unique identifier for the issue. */
  id: string;
  /** Category of the issue. */
  category: IssueCategory;
  /** How severe the issue is. */
  severity: Severity;
  /** Short title for the issue. */
  title: string;
  /** Detailed description. */
  description: string;
  /** File where the issue was found. */
  file: string;
  /** Line number, if applicable. */
  line: number | null;
  /** Current status of the issue. */
  status: IssueStatus;
  /** ISO timestamp when the issue was first discovered. */
  firstSeen: string;
  /** ISO timestamp when the issue was fixed, if applicable. */
  fixedAt: string | null;
}

/** An issue with full lifecycle tracking for the ledger. */
export interface LedgerEntry extends Issue {
  /** ISO timestamp of the last time this issue was seen during a scan. */
  lastSeen: string;
  /** Number of times this issue has been detected across scans. */
  occurrences: number;
  /** Whether the issue was previously fixed and has reappeared. */
  hasRegressed: boolean;
  /** Hash of the issue's signature for dedup. */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Project context
// ---------------------------------------------------------------------------

/** Describes the project being analyzed. */
export interface ProjectContext {
  /** Project name (from package.json or directory name). */
  name: string;
  /** Project type (e.g. "nextjs", "express", "fastify"). */
  type: string;
  /** Primary framework detected. */
  framework: string;
  /** Database technology detected (e.g. "prisma", "drizzle", null). */
  database: string | null;
  /** Auth solution detected (e.g. "next-auth", "clerk", null). */
  auth: string | null;
  /** Business domains identified in the project. */
  domains: string[];
  /** Free-form notes. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Diagnosis report
// ---------------------------------------------------------------------------

/** A full diagnosis report produced by backend-max. */
export interface DiagnosisReport {
  /** ISO timestamp when the report was generated. */
  timestamp: string;
  /** Overall health score from 0–100. */
  healthScore: number;
  /** All issues found. */
  issues: Issue[];
  /** Human-readable summary. */
  summary: string;
  /** Total number of route files found. */
  routeCount: number;
  /** Total number of individual endpoints (method handlers). */
  endpointCount: number;
  /** Contract analysis result, if performed. */
  contractResult: ContractResult | null;
  /** Project context. */
  context: ProjectContext;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Information about a detected middleware file. @public */
export interface MiddlewareInfo {
  /** Absolute path to the middleware file. */
  filePath: string;
  /** Route matcher patterns found in the config. */
  matchers: string[];
  /** Whether the middleware checks authentication. */
  hasAuth: boolean;
  /** Whether the middleware handles redirects. */
  hasRedirects: boolean;
  /** Whether the middleware modifies headers. */
  hasHeaders: boolean;
}

// ---------------------------------------------------------------------------
// Safety module
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prisma schema analysis
// ---------------------------------------------------------------------------

/** Parsed Prisma schema information. */
export interface PrismaSchemaInfo {
  /** All models found in the schema. */
  models: PrismaModel[];
  /** All enums found in the schema. */
  enums: PrismaEnum[];
  /** Absolute path to the schema.prisma file. */
  filePath: string;
}

/** A single Prisma model. */
export interface PrismaModel {
  /** Model name (e.g. "User"). */
  name: string;
  /** Fields defined on the model. */
  fields: PrismaField[];
  /** Composite indexes from @@index directives. */
  indexes: string[][];
  /** Unique constraints from @@unique directives. */
  uniqueConstraints: string[][];
}

/** A single field on a Prisma model. */
export interface PrismaField {
  /** Field name. */
  name: string;
  /** Field type (e.g. "String", "Int", "User"). */
  type: string;
  /** Whether the field is required (not optional). */
  isRequired: boolean;
  /** Whether the field is a list (e.g. Post[]). */
  isList: boolean;
  /** Whether the field is the primary key (@id). */
  isId: boolean;
  /** Whether the field has a @unique constraint. */
  isUnique: boolean;
  /** Whether the field has a @default value. */
  hasDefault: boolean;
  /** Whether the field is a relation. */
  isRelation: boolean;
}

/** A Prisma enum definition. */
export interface PrismaEnum {
  /** Enum name. */
  name: string;
  /** Enum values. */
  values: string[];
}

/** A database call detected in source code. */
export interface DatabaseCall {
  /** Model name (e.g. "user" from prisma.user.findMany). */
  model: string;
  /** Operation name (e.g. "findMany"). */
  operation: string;
  /** Fields referenced in where/select/include clauses. */
  fields: string[];
  /** File where the call was found. */
  file: string;
  /** Line number of the call. */
  line: number;
}

/** An issue found during Prisma cross-reference analysis. */
export interface PrismaIssue {
  /** Type of Prisma issue. */
  type: "nonexistent-model" | "nonexistent-field" | "missing-index";
  /** Human-readable description. */
  description: string;
  /** Model name involved. */
  model: string;
  /** Field name involved, if applicable. */
  field: string | null;
  /** File where the issue was found. */
  file: string;
  /** Line number. */
  line: number;
}

/** An issue found during migration drift detection. */
export interface MigrationIssue {
  /** Type of migration issue. */
  type: "no-migrations" | "stale-migration" | "drift-suspected";
  /** Human-readable description. */
  description: string;
}

// ---------------------------------------------------------------------------
// Server actions analysis
// ---------------------------------------------------------------------------

/** A Next.js Server Action detected in the codebase. */
export interface ServerAction {
  /** Function name. */
  name: string;
  /** Absolute file path. */
  filePath: string;
  /** Line number where the function is defined. */
  line: number;
  /** Whether the action uses Zod or similar validation. */
  hasValidation: boolean;
  /** Whether the action has try/catch error handling. */
  hasErrorHandling: boolean;
  /** Whether the action makes database calls. */
  hasDatabaseCalls: boolean;
  /** Whether the action has auth checks. */
  hasAuth: boolean;
  /** List of database call expressions. */
  databaseCalls: string[];
  /** True if 'use server' is at file level (all exports are actions). */
  isFileLevel: boolean;
}

// ---------------------------------------------------------------------------
// Type flow analysis
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live testing
// ---------------------------------------------------------------------------

/** Options for the live endpoint tester. */
export interface LiveTestOptions {
  /** Base URL to test against (e.g., "http://localhost:3000"). */
  baseUrl: string;
  /** Per-request timeout in milliseconds (default 5000). */
  timeout: number;
  /** Whether to include auth headers if available. */
  includeAuth?: boolean;
  /** If true, show what would be tested without making actual HTTP calls. */
  dryRun?: boolean;
}

/** Result of a single endpoint test. */
export interface EndpointTestResult {
  /** Full URL that was tested. */
  url: string;
  /** HTTP method used. */
  method: string;
  /** Response status code, or null if the request failed entirely. */
  statusCode: number | null;
  /** Time in milliseconds for the response. */
  responseTimeMs: number;
  /** Whether the test passed all checks. */
  passed: boolean;
  /** List of issues found during the test. */
  issues: string[];
}

/** Aggregated result of all live tests. */
export interface LiveTestResult {
  /** Endpoints that were tested. */
  tested: EndpointTestResult[];
  /** Endpoints that were skipped (with reasons). */
  skipped: string[];
  /** Summary counts. */
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
  };
}

// ---------------------------------------------------------------------------
// API graph
// ---------------------------------------------------------------------------

/** A queryable graph representation of the API surface. */
export interface ApiGraph {
  /** All nodes in the graph. */
  nodes: ApiNode[];
  /** All edges in the graph. */
  edges: ApiEdge[];
}

/** A single node in the API graph. */
export interface ApiNode {
  /** Unique identifier (e.g., "route:GET /api/users"). */
  id: string;
  /** Node type. */
  type: "route" | "model" | "frontend-component" | "middleware" | "server-action";
  /** Human-readable name. */
  name: string;
  /** Arbitrary metadata associated with the node. */
  metadata: Record<string, unknown>;
}

/** A directed edge between two nodes. */
export interface ApiEdge {
  /** Source node ID. */
  from: string;
  /** Target node ID. */
  to: string;
  /** Relationship type. */
  type: "calls" | "reads" | "writes" | "protects" | "validates";
}

/** Result of querying the API graph. */
export interface ApiQueryResult {
  /** Matching nodes. */
  nodes: ApiNode[];
  /** Matching edges. */
  edges: ApiEdge[];
  /** Human-readable description of the query result. */
  description: string;
}

// ---------------------------------------------------------------------------
// Cross-project pattern tracking
// ---------------------------------------------------------------------------

/** Insight about a common pattern across projects. */
export interface PatternInsight {
  /** Normalized pattern identifier. */
  pattern: string;
  /** Total occurrences across all projects. */
  occurrences: number;
  /** Number of distinct projects where this pattern appeared. */
  projects: number;
  /** Framework this pattern is associated with. */
  framework: string;
  /** Human-readable description. */
  description: string;
}

// ---------------------------------------------------------------------------
// Type flow analysis
// ---------------------------------------------------------------------------

/** A mismatch between frontend property usage and backend response shape. @public */
export interface TypeFlowIssue {
  /** Frontend file where the property was accessed. */
  frontendFile: string;
  /** Line number of the access. */
  frontendLine: number;
  /** Backend route URL. */
  backendRoute: string;
  /** The property path the frontend expects. */
  expectedProperty: string;
  /** Human-readable description. */
  description: string;
}

// ---------------------------------------------------------------------------
// Safety module
// ---------------------------------------------------------------------------

/** Configuration for scan scope enforcement. */
export interface ScopeLimits {
  /** Maximum number of files to scan. Default 5000. */
  maxFiles: number;
  /** Maximum size of a single file in bytes. Default 1 MB. */
  maxFileSizeBytes: number;
  /** Maximum directory depth to scan. Default 15. */
  maxScanDepth: number;
  /** Maximum total size of all scanned files in bytes. Default 100 MB. */
  maxTotalSizeBytes: number;
  /** Number of days to retain reports. Default 30. */
  reportRetentionDays: number;
  /** Whether to auto-add .backend-doctor/ to .gitignore. Default true. */
  autoGitignore: boolean;
  /** Directories to ignore during scanning. */
  ignoreDirs: string[];
}

/** Result of the unified safety check run at tool invocation start. */
export interface SafetyCheckResult {
  /** Whether all safety checks passed. */
  passed: boolean;
  /** Path validation result. */
  pathValidation: { valid: boolean; reason?: string };
  /** Whether .gitignore was modified to include .backend-doctor/. */
  gitignoreAdded: boolean;
  /** Warnings generated by scope enforcement. */
  scopeWarnings: string[];
  /** Number of old reports pruned. */
  reportsPruned: number;
}
