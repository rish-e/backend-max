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
  | "error-handling"
  | "validation"
  | "env"
  | "security"
  | "performance"
  | "nextjs"
  | "auth";

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

/** Information about a detected middleware file. */
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
