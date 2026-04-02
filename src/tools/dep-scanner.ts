// =============================================================================
// backend-max — Dependency vulnerability scanner
// =============================================================================

import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Issue } from "../types.js";
import { getTimestamp } from "../utils/helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the dependency scan. */
export interface DepScanResult {
  /** All dependency-related issues found. */
  issues: Issue[];
  /** Total number of dependencies scanned. */
  totalDeps: number;
  /** Number of dependencies with known issues. */
  flaggedDeps: number;
  /** Summary of the scan. */
  summary: string;
}

/** A parsed dependency entry. */
interface DepEntry {
  name: string;
  version: string;
  isDev: boolean;
}

// ---------------------------------------------------------------------------
// Known vulnerability patterns (heuristic-based, no network required)
// ---------------------------------------------------------------------------

/**
 * Known packages with security concerns at specific version ranges.
 * Format: [packageName, badVersionPrefix, severity, description]
 */
const KNOWN_VULNERABLE: Array<[string, (v: string) => boolean, Issue["severity"], string]> = [
  // Prototype pollution / RCE
  [
    "lodash",
    (v) => compareMajor(v, 4) < 0 || (compareMajor(v, 4) === 0 && compareMinor(v, 17) < 0),
    "critical",
    "lodash < 4.17.x has multiple prototype pollution vulnerabilities (CVE-2020-8203, CVE-2021-23337)",
  ],
  [
    "minimist",
    (v) => compareMajor(v, 1) < 0,
    "warning",
    "minimist < 1.x has prototype pollution vulnerability (CVE-2020-7598)",
  ],
  [
    "node-fetch",
    (v) => compareMajor(v, 2) < 0,
    "warning",
    "node-fetch < 2.x has multiple security issues including URL redirect vulnerabilities",
  ],
  [
    "axios",
    (v) => compareMajor(v, 1) < 0,
    "warning",
    "axios < 1.x has SSRF and ReDoS vulnerabilities. Upgrade to 1.x+",
  ],
  [
    "jsonwebtoken",
    (v) => compareMajor(v, 9) < 0,
    "critical",
    "jsonwebtoken < 9.x has key confusion vulnerabilities (CVE-2022-23529, CVE-2022-23539, CVE-2022-23540, CVE-2022-23541)",
  ],
  [
    "express",
    (v) => compareMajor(v, 4) < 0 || (compareMajor(v, 4) === 0 && compareMinor(v, 17) < 0),
    "warning",
    "express < 4.17.x has multiple denial-of-service vulnerabilities",
  ],
  [
    "tar",
    (v) => compareMajor(v, 6) < 0 || (compareMajor(v, 6) === 0 && compareMinor(v, 2) < 0),
    "critical",
    "tar < 6.2.x has arbitrary file creation/overwrite vulnerabilities (CVE-2021-32803, CVE-2021-32804)",
  ],
  [
    "glob-parent",
    (v) => compareMajor(v, 5) < 0 || (compareMajor(v, 5) === 0 && compareMinor(v, 1) < 0),
    "warning",
    "glob-parent < 5.1.x has ReDoS vulnerability (CVE-2020-28469)",
  ],
  [
    "semver",
    (v) => compareMajor(v, 7) < 0 || (compareMajor(v, 7) === 0 && compareMinor(v, 5) < 0),
    "warning",
    "semver < 7.5.x has ReDoS vulnerability (CVE-2022-25883)",
  ],
  [
    "xml2js",
    (v) => compareMajor(v, 0) === 0 && compareMinor(v, 5) < 0,
    "warning",
    "xml2js < 0.5.x has prototype pollution vulnerability (CVE-2023-0842)",
  ],
  [
    "qs",
    (v) => compareMajor(v, 6) < 0 || (compareMajor(v, 6) === 0 && compareMinor(v, 5) < 0),
    "warning",
    "qs < 6.5.x has prototype pollution vulnerability",
  ],
  [
    "tough-cookie",
    (v) => compareMajor(v, 4) < 0 || (compareMajor(v, 4) === 0 && compareMinor(v, 1) < 0),
    "warning",
    "tough-cookie < 4.1.x has prototype pollution vulnerability (CVE-2023-26136)",
  ],
  [
    "next",
    (v) => compareMajor(v, 13) < 0,
    "warning",
    "Next.js < 13.x is no longer receiving security patches. Upgrade to 13+ or later",
  ],
  [
    "react",
    (v) => compareMajor(v, 18) < 0,
    "info",
    "React < 18.x is outdated and missing important security improvements in server-side rendering",
  ],
];

/**
 * Packages that are commonly used but have better/safer alternatives.
 */
const DEPRECATED_ALTERNATIVES: Array<[string, string | ((v: string) => string), string]> = [
  [
    "request",
    "Use 'node-fetch', 'undici', or 'got' instead",
    "The 'request' package is deprecated and no longer maintained",
  ],
  [
    "querystring",
    "Use 'URLSearchParams' (built-in) instead",
    "Node.js built-in 'querystring' is legacy — use URLSearchParams",
  ],
  [
    "moment",
    "Use 'date-fns' or 'dayjs' instead",
    "moment.js is in maintenance mode and has known security issues with locale data",
  ],
  [
    "uuid",
    (v: string) =>
      compareMajor(v, 9) < 0 ? "Upgrade to uuid@9+ or use crypto.randomUUID() (built-in)" : "",
    "uuid < 9.x generates predictable UUIDs in some environments",
  ],
  [
    "colors",
    "Remove or replace — this package was compromised",
    "The 'colors' package was intentionally corrupted in v1.4.1+ (supply chain attack)",
  ],
  [
    "faker",
    "Use '@faker-js/faker' instead",
    "The 'faker' package was intentionally corrupted — use the community fork @faker-js/faker",
  ],
  [
    "event-stream",
    "Audit carefully — this package had a supply chain attack",
    "event-stream was compromised to steal cryptocurrency (CVE-2018-16490)",
  ],
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans project dependencies for known vulnerabilities and issues.
 *
 * This is a heuristic-based scanner that does NOT require network access.
 * It checks:
 * 1. Known vulnerable version ranges
 * 2. Deprecated/compromised packages
 * 3. Outdated major versions of critical packages
 * 4. npm audit (if available, optional)
 *
 * @param projectPath  Absolute path to the project root.
 * @returns DepScanResult with issues and summary.
 */
export async function scanDependencies(projectPath: string): Promise<DepScanResult> {
  const timestamp = getTimestamp();
  const issues: Issue[] = [];

  // 1. Parse package.json
  const deps = await parseDependencies(projectPath);
  if (deps.length === 0) {
    return {
      issues: [],
      totalDeps: 0,
      flaggedDeps: 0,
      summary: "No dependencies found in package.json.",
    };
  }

  // 2. Check against known vulnerability database
  for (const dep of deps) {
    for (const [pkgName, isVulnerable, severity, description] of KNOWN_VULNERABLE) {
      if (dep.name === pkgName) {
        const cleanVersion = cleanVersionString(dep.version);
        if (isVulnerable(cleanVersion)) {
          issues.push({
            id: "",
            category: "security",
            severity,
            title: `Vulnerable dependency: ${dep.name}@${dep.version}`,
            description,
            file: join(projectPath, "package.json"),
            line: null,
            status: "open",
            firstSeen: timestamp,
            fixedAt: null,
          });
        }
      }
    }
  }

  // 3. Check for deprecated/compromised packages
  for (const dep of deps) {
    for (const [pkgName, suggestion, reason] of DEPRECATED_ALTERNATIVES) {
      if (dep.name === pkgName) {
        const suggestionText =
          typeof suggestion === "function"
            ? suggestion(cleanVersionString(dep.version))
            : suggestion;

        if (!suggestionText) continue; // Function returned empty = not applicable

        issues.push({
          id: "",
          category: "security",
          severity: "info",
          title: `Deprecated/risky dependency: ${dep.name}`,
          description: `${reason}. ${suggestionText}`,
          file: join(projectPath, "package.json"),
          line: null,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }
  }

  // 4. Check for missing lock file
  const hasLockFile = await checkLockFile(projectPath);
  if (!hasLockFile) {
    issues.push({
      id: "",
      category: "security",
      severity: "warning",
      title: "No lock file found",
      description:
        "No package-lock.json, yarn.lock, or pnpm-lock.yaml found. Lock files ensure deterministic dependency resolution and prevent supply chain attacks via floating versions.",
      file: join(projectPath, "package.json"),
      line: null,
      status: "open",
      firstSeen: timestamp,
      fixedAt: null,
    });
  }

  // 5. Try npm audit (optional — may not be available in all environments)
  const npmAuditIssues = await tryNpmAudit(projectPath, timestamp);
  issues.push(...npmAuditIssues);

  // 6. Check for overly permissive version ranges
  const rangeIssues = checkVersionRanges(deps, projectPath, timestamp);
  issues.push(...rangeIssues);

  const flaggedDeps = new Set(
    issues.map((i) => i.title.match(/: (.+?)(?:@|$)/)?.[1]).filter(Boolean),
  ).size;

  const summary = [
    `Scanned ${deps.length} dependencies.`,
    issues.length > 0
      ? `Found ${issues.length} issue(s) in ${flaggedDeps} package(s).`
      : "No known vulnerabilities detected.",
  ].join(" ");

  return {
    issues,
    totalDeps: deps.length,
    flaggedDeps,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Dependency parsing
// ---------------------------------------------------------------------------

/**
 * Parses all dependencies from package.json.
 */
async function parseDependencies(projectPath: string): Promise<DepEntry[]> {
  try {
    const raw = await readFile(join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object") return [];

    const entries: DepEntry[] = [];

    const deps =
      pkg.dependencies && typeof pkg.dependencies === "object"
        ? (pkg.dependencies as Record<string, string>)
        : {};
    for (const [name, version] of Object.entries(deps)) {
      entries.push({ name, version, isDev: false });
    }

    const devDeps =
      pkg.devDependencies && typeof pkg.devDependencies === "object"
        ? (pkg.devDependencies as Record<string, string>)
        : {};
    for (const [name, version] of Object.entries(devDeps)) {
      entries.push({ name, version, isDev: true });
    }

    return entries;
  } catch {
    /* skip: unreadable/unparseable package.json */
    return [];
  }
}

/**
 * Checks if a lock file exists.
 */
async function checkLockFile(projectPath: string): Promise<boolean> {
  const lockFiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];

  for (const lockFile of lockFiles) {
    try {
      await readFile(join(projectPath, lockFile));
      return true;
    } catch {
      /* skip: lock file not found — continue checking */
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// npm audit integration
// ---------------------------------------------------------------------------

/**
 * Attempts to run npm audit and parse results.
 * This is optional — failures are silently ignored.
 */
async function tryNpmAudit(projectPath: string, timestamp: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  try {
    // Only attempt if package-lock.json exists (npm audit requires it)
    await readFile(join(projectPath, "package-lock.json"));
  } catch {
    /* No lock file = can't run npm audit */
    return [];
  }

  try {
    const output = execSync("npm audit --json 2>/dev/null", {
      cwd: projectPath,
      timeout: 30000,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });

    const auditResult = JSON.parse(output) as {
      vulnerabilities?: Record<
        string,
        {
          severity: string;
          via: Array<{ title?: string; url?: string } | string>;
          fixAvailable?: boolean | { name: string; version: string };
        }
      >;
    };

    if (auditResult.vulnerabilities) {
      for (const [pkgName, vuln] of Object.entries(auditResult.vulnerabilities)) {
        // Map npm audit severity to our severity
        const severity: Issue["severity"] =
          vuln.severity === "critical" || vuln.severity === "high"
            ? "critical"
            : vuln.severity === "moderate"
              ? "warning"
              : "info";

        const viaDescriptions = vuln.via
          .filter((v): v is { title?: string; url?: string } => typeof v !== "string")
          .map((v) => v.title ?? "Unknown vulnerability")
          .join("; ");

        const fixAvailable = vuln.fixAvailable
          ? typeof vuln.fixAvailable === "object"
            ? ` Fix: upgrade to ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
            : " Fix available via npm audit fix."
          : "";

        issues.push({
          id: "",
          category: "security",
          severity,
          title: `npm audit: ${pkgName} (${vuln.severity})`,
          description: `${viaDescriptions || "Vulnerability detected by npm audit."}${fixAvailable}`,
          file: join(projectPath, "package.json"),
          line: null,
          status: "open",
          firstSeen: timestamp,
          fixedAt: null,
        });
      }
    }
  } catch {
    /* skip: npm audit failed — non-fatal, heuristic checks still run */
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Version range checks
// ---------------------------------------------------------------------------

/**
 * Checks for overly permissive version ranges that could introduce breaking changes.
 */
function checkVersionRanges(deps: DepEntry[], projectPath: string, timestamp: string): Issue[] {
  const issues: Issue[] = [];

  for (const dep of deps) {
    if (dep.isDev) continue; // Only flag production dependencies

    // Check for * or latest
    if (dep.version === "*" || dep.version === "latest") {
      issues.push({
        id: "",
        category: "security",
        severity: "warning",
        title: `Unpinned dependency: ${dep.name}@${dep.version}`,
        description: `Using "${dep.version}" allows any version to be installed, including potentially malicious ones. Pin to a specific version range.`,
        file: join(projectPath, "package.json"),
        line: null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }

    // Check for >= ranges (no upper bound)
    if (dep.version.startsWith(">=") && !dep.version.includes("<")) {
      issues.push({
        id: "",
        category: "security",
        severity: "info",
        title: `Unbounded version range: ${dep.name}@${dep.version}`,
        description:
          "This version range has no upper bound, which could pull in breaking major versions. Consider using ^ or ~ instead.",
        file: join(projectPath, "package.json"),
        line: null,
        status: "open",
        firstSeen: timestamp,
        fixedAt: null,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Version comparison utilities
// ---------------------------------------------------------------------------

/**
 * Strips semver prefixes (^, ~, >=, etc.) and returns a clean version string.
 */
function cleanVersionString(version: string): string {
  return version.replace(/^[\^~>=<]+/, "").replace(/-.*$/, "");
}

/**
 * Compares the major version of a semver string against a target.
 * Returns negative if version < target, 0 if equal, positive if greater.
 */
function compareMajor(version: string, target: number): number {
  const major = parseInt(version.split(".")[0], 10);
  if (Number.isNaN(major)) return -1;
  return major - target;
}

/**
 * Compares the minor version of a semver string against a target.
 */
function compareMinor(version: string, target: number): number {
  const parts = version.split(".");
  const minor = parseInt(parts[1] ?? "0", 10);
  if (Number.isNaN(minor)) return -1;
  return minor - target;
}
