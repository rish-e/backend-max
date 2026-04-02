import { describe, it, expect } from "vitest";
import {
  BLOCKED_PATHS,
  BLOCKED_FILE_PATTERNS,
  validateProjectPath,
  isAllowedFile,
  isWriteSafe,
  sanitizeEnvContent,
} from "../safety/path-guardian.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("BLOCKED_PATHS", () => {
  it("contains .ssh", () => {
    expect(BLOCKED_PATHS).toContain(".ssh");
  });

  it("contains .aws", () => {
    expect(BLOCKED_PATHS).toContain(".aws");
  });

  it("contains .gnupg", () => {
    expect(BLOCKED_PATHS).toContain(".gnupg");
  });

  it("contains .kube", () => {
    expect(BLOCKED_PATHS).toContain(".kube");
  });

  it("contains .password-store", () => {
    expect(BLOCKED_PATHS).toContain(".password-store");
  });
});

describe("BLOCKED_FILE_PATTERNS", () => {
  it("contains .env", () => {
    expect(BLOCKED_FILE_PATTERNS).toContain(".env");
  });

  it("contains *.pem", () => {
    expect(BLOCKED_FILE_PATTERNS).toContain("*.pem");
  });

  it("contains id_rsa*", () => {
    expect(BLOCKED_FILE_PATTERNS).toContain("id_rsa*");
  });

  it("contains *.key", () => {
    expect(BLOCKED_FILE_PATTERNS).toContain("*.key");
  });

  it("contains id_ed25519*", () => {
    expect(BLOCKED_FILE_PATTERNS).toContain("id_ed25519*");
  });
});

// ---------------------------------------------------------------------------
// validateProjectPath
// ---------------------------------------------------------------------------

describe("validateProjectPath", () => {
  it("allows a normal project directory", () => {
    // Use the current project as a known-valid directory
    const result = validateProjectPath(process.cwd());
    expect(result.valid).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    const result = validateProjectPath("/nonexistent/path/to/nowhere");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not exist/);
  });

  it("rejects the home directory itself", () => {
    const result = validateProjectPath(homedir());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/home directory/);
  });

  it("rejects system directories like /usr", () => {
    const result = validateProjectPath("/usr");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/system directory/);
  });

  it("rejects subdirectories of system paths", () => {
    // /usr/bin is a subdirectory of /usr, which is a blocked system dir
    const result = validateProjectPath("/usr/bin");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/system directory/);
  });

  it("rejects sensitive home subdirectories (~/.ssh, ~/.aws)", () => {
    // These may or may not exist on the test machine, so we just
    // verify the result is invalid regardless of the specific reason.
    const sshResult = validateProjectPath(join(homedir(), ".ssh"));
    expect(sshResult.valid).toBe(false);

    const awsResult = validateProjectPath(join(homedir(), ".aws"));
    expect(awsResult.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowedFile
// ---------------------------------------------------------------------------

describe("isAllowedFile", () => {
  const projectRoot = process.cwd();

  it("allows a normal source file within the project", () => {
    const filePath = join(projectRoot, "src", "index.ts");
    expect(isAllowedFile(filePath, projectRoot)).toBe(true);
  });

  it("blocks files outside the project directory (path traversal)", () => {
    const filePath = join(projectRoot, "..", "..", "etc", "passwd");
    expect(isAllowedFile(filePath, projectRoot)).toBe(false);
  });

  it("blocks .env files", () => {
    const filePath = join(projectRoot, ".env");
    expect(isAllowedFile(filePath, projectRoot)).toBe(false);
  });

  it("blocks .pem files", () => {
    const filePath = join(projectRoot, "certs", "server.pem");
    expect(isAllowedFile(filePath, projectRoot)).toBe(false);
  });

  it("blocks id_rsa files", () => {
    const filePath = join(projectRoot, "id_rsa");
    expect(isAllowedFile(filePath, projectRoot)).toBe(false);
  });

  it("blocks files in .git/objects", () => {
    const filePath = join(projectRoot, ".git", "objects", "ab", "cd1234");
    expect(isAllowedFile(filePath, projectRoot)).toBe(false);
  });

  it("blocks files in node_modules/.cache", () => {
    const filePath = join(projectRoot, "node_modules", ".cache", "somefile");
    expect(isAllowedFile(filePath, projectRoot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeEnvContent
// ---------------------------------------------------------------------------

describe("sanitizeEnvContent", () => {
  it("strips values but preserves variable names", () => {
    const input = "DATABASE_URL=postgres://user:pass@host:5432/db\nSECRET_KEY=mysecret";
    const result = sanitizeEnvContent(input);
    expect(result).toBe("DATABASE_URL=\nSECRET_KEY=");
  });

  it("preserves comments and empty lines", () => {
    const input = "# This is a comment\n\nAPI_KEY=supersecret";
    const result = sanitizeEnvContent(input);
    expect(result).toBe("# This is a comment\n\nAPI_KEY=");
  });

  it("handles empty input", () => {
    expect(sanitizeEnvContent("")).toBe("");
  });
});
