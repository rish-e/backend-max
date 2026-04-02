// =============================================================================
// backend-max — SARIF 2.1.0 report formatter (GitHub Code Scanning)
// =============================================================================

import type { DiagnosisReport, Severity } from "../types.js";

/** SARIF severity levels. */
type SarifLevel = "error" | "warning" | "note" | "none";

/** SARIF 2.1.0 schema URI. */
const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";

/**
 * Formats a DiagnosisReport as a SARIF 2.1.0 object suitable for
 * GitHub Code Scanning integration.
 *
 * @param report  The diagnosis report to format.
 * @returns A valid SARIF 2.1.0 object.
 */
export function formatSarifReport(report: DiagnosisReport): object {
  // Build rule definitions from unique issue categories/titles
  const rulesMap = new Map<string, SarifRule>();
  const results: SarifResult[] = [];

  for (const issue of report.issues) {
    const ruleId = issue.id || `backend-max-${issue.category}`;

    if (!rulesMap.has(ruleId)) {
      rulesMap.set(ruleId, {
        id: ruleId,
        name: sanitizeRuleName(issue.title),
        shortDescription: {
          text: issue.title,
        },
        fullDescription: {
          text: issue.description,
        },
        defaultConfiguration: {
          level: mapSeverityToSarif(issue.severity),
        },
        properties: {
          category: issue.category,
        },
      });
    }

    results.push({
      ruleId,
      level: mapSeverityToSarif(issue.severity),
      message: {
        text: issue.description,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: issue.file,
              uriBaseId: "%SRCROOT%",
            },
            region: issue.line
              ? {
                  startLine: issue.line,
                  startColumn: 1,
                }
              : undefined,
          },
        },
      ],
    });
  }

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "backend-max",
            version: "1.1.0",
            informationUri: "https://github.com/rishi-kolisetty/backend-max",
            rules: Array.from(rulesMap.values()),
          },
        },
        results,
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              healthScore: report.healthScore,
              framework: report.context.framework,
              routeCount: report.routeCount,
              endpointCount: report.endpointCount,
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps backend-max severity to SARIF level.
 */
function mapSeverityToSarif(severity: Severity): SarifLevel {
  switch (severity) {
    case "critical":
    case "bug":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "note";
    default:
      return "note";
  }
}

/**
 * Sanitizes a title string into a valid SARIF rule name (PascalCase-ish).
 */
function sanitizeRuleName(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

// ---------------------------------------------------------------------------
// Internal SARIF types (just enough for serialization)
// ---------------------------------------------------------------------------

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { category: string };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: string };
      region?: { startLine: number; startColumn: number };
    };
  }>;
}
