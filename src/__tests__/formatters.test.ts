import { describe, it, expect } from "vitest";
import { formatTextReport } from "../formatters/text.js";
import { formatMarkdownReport } from "../formatters/markdown.js";
import { formatSarifReport } from "../formatters/sarif.js";
import type { DiagnosisReport, Issue } from "../types.js";

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "CTR-abc123",
    category: "contract",
    severity: "warning",
    title: "Missing validation",
    description: "The POST handler does not validate the request body.",
    file: "src/api/users.ts",
    line: 42,
    status: "open",
    firstSeen: "2025-01-01T00:00:00.000Z",
    fixedAt: null,
    ...overrides,
  };
}

function makeReport(issues: Issue[] = []): DiagnosisReport {
  return {
    timestamp: "2025-01-15T12:00:00.000Z",
    healthScore: 85,
    issues,
    summary: "Test diagnosis report",
    routeCount: 10,
    endpointCount: 25,
    contractResult: null,
    context: {
      name: "test-project",
      type: "nextjs",
      framework: "Next.js",
      database: "prisma",
      auth: "next-auth",
      domains: ["users", "posts"],
      notes: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

describe("formatTextReport", () => {
  it("produces output containing the health score", () => {
    const report = makeReport();
    const output = formatTextReport(report);
    expect(output).toContain("85");
    expect(output).toContain("100");
  });

  it("shows the framework name", () => {
    const report = makeReport();
    const output = formatTextReport(report);
    expect(output).toContain("Next.js");
  });

  it("shows 'No issues found' for empty issues array", () => {
    const report = makeReport([]);
    const output = formatTextReport(report);
    expect(output).toContain("No issues found");
  });

  it("displays critical issues when present", () => {
    const report = makeReport([
      makeIssue({ severity: "critical", title: "SQL Injection Risk" }),
    ]);
    const output = formatTextReport(report);
    expect(output).toContain("SQL Injection Risk");
    expect(output).toContain("Critical Issues");
  });

  it("displays warning issues when present", () => {
    const report = makeReport([makeIssue({ severity: "warning", title: "No auth check" })]);
    const output = formatTextReport(report);
    expect(output).toContain("No auth check");
    expect(output).toContain("Warnings");
  });

  it("includes route and endpoint counts", () => {
    const report = makeReport();
    const output = formatTextReport(report);
    expect(output).toContain("10");
    expect(output).toContain("25");
  });
});

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

describe("formatMarkdownReport", () => {
  it("produces valid markdown with a top-level heading", () => {
    const report = makeReport();
    const output = formatMarkdownReport(report);
    expect(output).toContain("# Backend Max Diagnosis Report");
  });

  it("includes a health score badge", () => {
    const report = makeReport();
    const output = formatMarkdownReport(report);
    expect(output).toContain("health--score");
    expect(output).toContain("85");
  });

  it("includes framework information", () => {
    const report = makeReport();
    const output = formatMarkdownReport(report);
    expect(output).toContain("**Framework:** Next.js");
  });

  it("shows 'No issues found' for empty issues", () => {
    const report = makeReport([]);
    const output = formatMarkdownReport(report);
    expect(output).toContain("No issues found");
  });

  it("includes a summary table", () => {
    const report = makeReport();
    const output = formatMarkdownReport(report);
    expect(output).toContain("## Summary");
    expect(output).toContain("| Health Score | 85/100 |");
  });

  it("renders critical issues under a Critical Issues heading", () => {
    const report = makeReport([
      makeIssue({ severity: "critical", title: "Dangerous endpoint" }),
    ]);
    const output = formatMarkdownReport(report);
    expect(output).toContain("## Critical Issues");
    expect(output).toContain("Dangerous endpoint");
  });

  it("includes contract analysis table when present", () => {
    const report = makeReport();
    report.contractResult = { mismatches: [], matchedCount: 8, unmatchedCount: 2 };
    const output = formatMarkdownReport(report);
    expect(output).toContain("## Contract Analysis");
    expect(output).toContain("| Matched | 8 |");
    expect(output).toContain("| Unmatched | 2 |");
  });
});

// ---------------------------------------------------------------------------
// SARIF formatter
// ---------------------------------------------------------------------------

describe("formatSarifReport", () => {
  it("produces a valid SARIF structure with $schema, version, and runs", () => {
    const report = makeReport();
    const sarif = formatSarifReport(report) as Record<string, unknown>;
    expect(sarif.$schema).toContain("sarif-schema-2.1.0");
    expect(sarif.version).toBe("2.1.0");
    expect(Array.isArray(sarif.runs)).toBe(true);
  });

  it("includes tool driver information", () => {
    const report = makeReport();
    const sarif = formatSarifReport(report) as any;
    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe("backend-max");
    expect(driver.version).toBeDefined();
  });

  it("maps critical issues to SARIF error level", () => {
    const report = makeReport([makeIssue({ severity: "critical" })]);
    const sarif = formatSarifReport(report) as any;
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(1);
    expect(results[0].level).toBe("error");
  });

  it("maps warning issues to SARIF warning level", () => {
    const report = makeReport([makeIssue({ severity: "warning" })]);
    const sarif = formatSarifReport(report) as any;
    expect(sarif.runs[0].results[0].level).toBe("warning");
  });

  it("maps info issues to SARIF note level", () => {
    const report = makeReport([makeIssue({ severity: "info" })]);
    const sarif = formatSarifReport(report) as any;
    expect(sarif.runs[0].results[0].level).toBe("note");
  });

  it("returns empty results for a report with no issues", () => {
    const report = makeReport([]);
    const sarif = formatSarifReport(report) as any;
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });

  it("includes health score and framework in invocation properties", () => {
    const report = makeReport();
    const sarif = formatSarifReport(report) as any;
    const props = sarif.runs[0].invocations[0].properties;
    expect(props.healthScore).toBe(85);
    expect(props.framework).toBe("Next.js");
  });

  it("sets artifact location with file path and uriBaseId", () => {
    const report = makeReport([makeIssue()]);
    const sarif = formatSarifReport(report) as any;
    const loc = sarif.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe("src/api/users.ts");
    expect(loc.artifactLocation.uriBaseId).toBe("%SRCROOT%");
    expect(loc.region.startLine).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Consistency across formatters
// ---------------------------------------------------------------------------

describe("All formatters handle the same report consistently", () => {
  const issues = [
    makeIssue({ severity: "critical", title: "Critical bug" }),
    makeIssue({ severity: "warning", title: "Missing auth", id: "SEC-def456" }),
    makeIssue({ severity: "info", title: "Consider caching", id: "CCH-789abc" }),
  ];
  const report = makeReport(issues);

  it("text formatter includes all issue titles", () => {
    const output = formatTextReport(report);
    expect(output).toContain("Critical bug");
    expect(output).toContain("Missing auth");
    expect(output).toContain("Consider caching");
  });

  it("markdown formatter includes all issue titles", () => {
    const output = formatMarkdownReport(report);
    expect(output).toContain("Critical bug");
    expect(output).toContain("Missing auth");
    expect(output).toContain("Consider caching");
  });

  it("SARIF formatter includes all issues as results", () => {
    const sarif = formatSarifReport(report) as any;
    expect(sarif.runs[0].results).toHaveLength(3);
  });
});
