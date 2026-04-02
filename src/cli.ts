#!/usr/bin/env node

/**
 * Backend Max CLI -- Run diagnostics from the command line.
 *
 * Usage: npx backend-max-cli diagnose [path] [options]
 *
 * Options:
 *   --ci              CI mode: exit with code 1 if critical issues found
 *   --min-score <n>   Minimum health score (default: 0)
 *   --fail-on <level> Fail on severity level: critical, warning, info
 *   --focus <area>    Focus: all, routes, contracts, errors, env, security, performance
 *   --json            Output raw JSON instead of formatted text
 *   --format <fmt>    Output format: text, json, markdown, sarif
 */

import { resolve } from "node:path";
import { formatMarkdownReport } from "./formatters/markdown.js";
import { formatSarifReport } from "./formatters/sarif.js";
import { formatTextReport } from "./formatters/text.js";
import { runFullDiagnosis } from "./tools/orchestrator.js";
import type { DiagnosisReport, Severity } from "./types.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  command: string;
  projectPath: string;
  ci: boolean;
  minScore: number;
  failOn: Severity | null;
  focus: string;
  format: "text" | "json" | "markdown" | "sarif";
}

/**
 * Parses process.argv into structured CLI options.
 */
function parseArgs(argv: string[]): CliOptions {
  // Strip node binary and script path
  const args = argv.slice(2);

  const options: CliOptions = {
    command: "",
    projectPath: process.cwd(),
    ci: false,
    minScore: 0,
    failOn: null,
    focus: "all",
    format: "text",
  };

  let i = 0;

  // First positional arg is the command
  if (args.length > 0 && !args[0].startsWith("-")) {
    options.command = args[0];
    i = 1;
  }

  // Second positional arg (if not a flag) is the path
  if (i < args.length && !args[i].startsWith("-")) {
    options.projectPath = resolve(args[i]);
    i++;
  }

  // Parse flags
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "--ci":
        options.ci = true;
        break;

      case "--json":
        options.format = "json";
        break;

      case "--min-score": {
        if (i + 1 >= args.length) {
          console.error("Error: --min-score requires a value.");
          printUsage();
          process.exit(1);
        }
        const val = args[++i];
        if (val !== undefined) {
          const parsed = parseInt(val, 10);
          if (!Number.isNaN(parsed)) {
            options.minScore = parsed;
          }
        }
        break;
      }

      case "--fail-on": {
        if (i + 1 >= args.length) {
          console.error("Error: --fail-on requires a value (critical, warning, info).");
          printUsage();
          process.exit(1);
        }
        const val = args[++i];
        if (val === "critical" || val === "warning" || val === "info" || val === "bug") {
          options.failOn = val as Severity;
        }
        break;
      }

      case "--focus": {
        if (i + 1 >= args.length) {
          console.error("Error: --focus requires a value.");
          printUsage();
          process.exit(1);
        }
        const val = args[++i];
        if (val) {
          options.focus = val;
        }
        break;
      }

      case "--format": {
        if (i + 1 >= args.length) {
          console.error("Error: --format requires a value (text, json, markdown, sarif).");
          printUsage();
          process.exit(1);
        }
        const val = args[++i];
        if (val === "text" || val === "json" || val === "markdown" || val === "sarif") {
          options.format = val;
        }
        break;
      }

      case "--version":
      case "-v":
        console.log("backend-max 2.2.0");
        process.exit(0);
        break;

      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;

      default:
        // Unknown flag -- ignore gracefully
        break;
    }

    i++;
  }

  return options;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Formats a report based on the selected output format.
 */
function formatOutput(report: DiagnosisReport, format: CliOptions["format"]): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);

    case "markdown":
      return formatMarkdownReport(report);

    case "sarif":
      return JSON.stringify(formatSarifReport(report), null, 2);
    default:
      return formatTextReport(report);
  }
}

// ---------------------------------------------------------------------------
// CI exit logic
// ---------------------------------------------------------------------------

/** Severity ordering for threshold comparison. */
const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  bug: 2,
  critical: 3,
};

/**
 * Determines whether the CI run should fail based on options and report.
 *
 * @returns True if the process should exit with code 1.
 */
function shouldFail(report: DiagnosisReport, options: CliOptions): boolean {
  // Check minimum score
  if (report.healthScore < options.minScore) {
    return true;
  }

  // Check fail-on severity threshold
  if (options.failOn) {
    const threshold = SEVERITY_ORDER[options.failOn] ?? 0;
    const hasIssuesAtOrAbove = report.issues.some(
      (issue) => (SEVERITY_ORDER[issue.severity] ?? 0) >= threshold,
    );
    if (hasIssuesAtOrAbove) {
      return true;
    }
  }

  // Default CI mode: fail on critical issues
  if (options.ci && !options.failOn && options.minScore === 0) {
    const hasCritical = report.issues.some(
      (i) => i.severity === "critical" || i.severity === "bug",
    );
    if (hasCritical) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

/**
 * Returns a one-line summary string.
 */
function summaryLine(report: DiagnosisReport): string {
  const critical = report.issues.filter(
    (i) => i.severity === "critical" || i.severity === "bug",
  ).length;
  const warnings = report.issues.filter((i) => i.severity === "warning").length;
  const info = report.issues.filter((i) => i.severity === "info").length;

  return `Backend Max: ${report.healthScore}/100 | ${critical} critical | ${warnings} warnings | ${info} info`;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Prints usage instructions. */
function printUsage(): void {
  const usage = `
Backend Max CLI -- AI-powered backend diagnostics

Usage:
  backend-max-cli diagnose [path] [options]

Commands:
  diagnose    Run a full backend diagnosis (default)

Options:
  --ci              CI mode: exit with code 1 if critical issues found
  --min-score <n>   Minimum health score threshold (default: 0)
  --fail-on <level> Fail on severity: critical, warning, info
  --focus <area>    Focus: all, routes, contracts, errors, env, security, performance
  --json            Shorthand for --format json
  --format <fmt>    Output format: text, json, markdown, sarif
  -v, --version     Show version number
  -h, --help        Show this help message

Examples:
  backend-max-cli diagnose ./my-app
  backend-max-cli diagnose ./my-app --ci --min-score 80
  backend-max-cli diagnose ./my-app --format sarif > report.sarif
  backend-max-cli diagnose --focus security --json
`.trim();

  console.log(usage);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  // Default command is "diagnose"
  if (!options.command || options.command === "diagnose") {
    try {
      const report = await runFullDiagnosis(options.projectPath, options.focus);

      // Output the formatted report
      const output = formatOutput(report, options.format);
      console.log(output);

      // Print summary line (unless JSON/SARIF where it would break parsing)
      if (options.format === "text" || options.format === "markdown") {
        console.log(summaryLine(report));
      }

      // CI exit logic
      if (options.ci || options.minScore > 0 || options.failOn) {
        if (shouldFail(report, options)) {
          process.exit(1);
        }
      }
    } catch (error) {
      console.error(`Diagnosis failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  } else {
    console.error(`Unknown command: ${options.command}`);
    printUsage();
    process.exit(1);
  }
}

main();
