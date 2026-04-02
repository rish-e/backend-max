import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateIssueId,
  calculateHealthScore,
  readJsonSafe,
  writeJson,
  relativePath,
} from "../utils/helpers.js";
import type { Issue } from "../types.js";

// ---------------------------------------------------------------------------
// Helper to create Issue objects for testing
// ---------------------------------------------------------------------------

function makeIssue(severity: Issue["severity"]): Issue {
  return {
    id: "TEST-001",
    category: "contract",
    severity,
    title: "Test issue",
    description: "A test issue",
    file: "src/test.ts",
    line: 1,
    status: "open",
    firstSeen: new Date().toISOString(),
    fixedAt: null,
  };
}

// ---------------------------------------------------------------------------
// generateIssueId
// ---------------------------------------------------------------------------

describe("generateIssueId", () => {
  it('returns an ID starting with "CTR-" for category "contract"', () => {
    const id = generateIssueId("contract", "src/api/users.ts", "missing field");
    expect(id).toMatch(/^CTR-[0-9a-f]{6}$/);
  });

  it('returns an ID starting with "SEC-" for category "security"', () => {
    const id = generateIssueId("security", "src/auth.ts", "no auth");
    expect(id).toMatch(/^SEC-[0-9a-f]{6}$/);
  });

  it("uses the first 3 chars uppercased for unmapped categories", () => {
    const id = generateIssueId("unknown-category", "src/foo.ts", "detail");
    expect(id).toMatch(/^UNK-[0-9a-f]{6}$/);
  });

  it("is deterministic — same inputs always produce the same ID", () => {
    const a = generateIssueId("contract", "src/api/users.ts", "missing field");
    const b = generateIssueId("contract", "src/api/users.ts", "missing field");
    expect(a).toBe(b);
  });

  it("produces different IDs for different inputs", () => {
    const a = generateIssueId("contract", "src/api/users.ts", "missing field");
    const b = generateIssueId("contract", "src/api/users.ts", "wrong type");
    expect(a).not.toBe(b);
  });

  it("maps all known categories to their expected prefixes", () => {
    expect(generateIssueId("error-handling", "f", "d")).toMatch(/^ERR-/);
    expect(generateIssueId("validation", "f", "d")).toMatch(/^VAL-/);
    expect(generateIssueId("env", "f", "d")).toMatch(/^ENV-/);
    expect(generateIssueId("performance", "f", "d")).toMatch(/^PRF-/);
    expect(generateIssueId("nextjs", "f", "d")).toMatch(/^NXT-/);
    expect(generateIssueId("express", "f", "d")).toMatch(/^EXP-/);
    expect(generateIssueId("auth", "f", "d")).toMatch(/^AUT-/);
    expect(generateIssueId("prisma", "f", "d")).toMatch(/^PRS-/);
    expect(generateIssueId("graphql", "f", "d")).toMatch(/^GQL-/);
    expect(generateIssueId("dependency", "f", "d")).toMatch(/^DEP-/);
    expect(generateIssueId("fastify", "f", "d")).toMatch(/^FST-/);
    expect(generateIssueId("hono", "f", "d")).toMatch(/^HNO-/);
    expect(generateIssueId("rate-limit", "f", "d")).toMatch(/^RTL-/);
    expect(generateIssueId("caching", "f", "d")).toMatch(/^CCH-/);
    expect(generateIssueId("middleware", "f", "d")).toMatch(/^MDW-/);
  });
});

// ---------------------------------------------------------------------------
// calculateHealthScore
// ---------------------------------------------------------------------------

describe("calculateHealthScore", () => {
  it("returns 100 for an empty issues array", () => {
    expect(calculateHealthScore([])).toBe(100);
  });

  it("deducts 10 for a critical issue", () => {
    expect(calculateHealthScore([makeIssue("critical")])).toBe(90);
  });

  it("deducts 10 for a bug issue", () => {
    expect(calculateHealthScore([makeIssue("bug")])).toBe(90);
  });

  it("deducts 5 for a warning issue", () => {
    expect(calculateHealthScore([makeIssue("warning")])).toBe(95);
  });

  it("deducts 1 for an info issue", () => {
    expect(calculateHealthScore([makeIssue("info")])).toBe(99);
  });

  it("handles a mix of severities correctly", () => {
    const issues = [
      makeIssue("critical"),
      makeIssue("warning"),
      makeIssue("warning"),
      makeIssue("info"),
    ];
    // 100 - 10 - 5 - 5 - 1 = 79
    expect(calculateHealthScore(issues)).toBe(79);
  });

  it("never returns below 0 even with many critical issues", () => {
    const issues = Array.from({ length: 15 }, () => makeIssue("critical"));
    // 100 - 150 = -50, clamped to 0
    expect(calculateHealthScore(issues)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readJsonSafe / writeJson (file system tests)
// ---------------------------------------------------------------------------

describe("readJsonSafe", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "helpers-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads and parses a valid JSON file", async () => {
    const filePath = join(tempDir, "data.json");
    await writeFile(filePath, JSON.stringify({ hello: "world" }), "utf-8");

    const result = await readJsonSafe<{ hello: string }>(filePath, { hello: "fallback" });
    expect(result).toEqual({ hello: "world" });
  });

  it("returns the fallback for a missing file", async () => {
    const result = await readJsonSafe(join(tempDir, "nope.json"), { default: true });
    expect(result).toEqual({ default: true });
  });

  it("returns the fallback for invalid JSON", async () => {
    const filePath = join(tempDir, "bad.json");
    await writeFile(filePath, "not valid json {{{", "utf-8");

    const result = await readJsonSafe(filePath, []);
    expect(result).toEqual([]);
  });
});

describe("writeJson", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "helpers-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a file with pretty-printed JSON and trailing newline", async () => {
    const filePath = join(tempDir, "output.json");
    await writeJson(filePath, { key: "value", num: 42 });

    const raw = await readFile(filePath, "utf-8");
    expect(raw).toBe(`${JSON.stringify({ key: "value", num: 42 }, null, 2)}\n`);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("creates parent directories if they do not exist", async () => {
    const filePath = join(tempDir, "nested", "deep", "file.json");
    await writeJson(filePath, { nested: true });

    const raw = await readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ nested: true });
  });
});

// ---------------------------------------------------------------------------
// relativePath
// ---------------------------------------------------------------------------

describe("relativePath", () => {
  it("converts an absolute path to a path relative to the project root", () => {
    const result = relativePath("/home/user/project", "/home/user/project/src/index.ts");
    expect(result).toBe("src/index.ts");
  });

  it("handles paths that are the same", () => {
    const result = relativePath("/home/user/project", "/home/user/project");
    expect(result).toBe("");
  });

  it("handles paths outside the project root", () => {
    const result = relativePath("/home/user/project", "/home/user/other/file.ts");
    expect(result).toBe("../other/file.ts");
  });
});
