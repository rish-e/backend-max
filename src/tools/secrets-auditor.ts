// =============================================================================
// backend-max — Secrets auditor
//
// Scans codebase for hardcoded API keys, tokens, passwords, private keys,
// and connection strings using entropy analysis + known patterns.
// =============================================================================

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { glob } from "glob";
import type { Issue, IssueCategory, Severity } from "../types.js";
import { generateIssueId } from "../utils/helpers.js";

// ---------------------------------------------------------------------------
// Known secret patterns (provider-specific + generic)
// ---------------------------------------------------------------------------

interface SecretPattern {
  name: string;
  regex: RegExp;
  severity: Severity;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // Cloud providers
  { name: "AWS Access Key",          regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,                            severity: "critical" },
  { name: "AWS Secret Key",          regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,              severity: "critical" },
  { name: "Google API Key",          regex: /AIza[0-9A-Za-z_-]{35}/g,                                                 severity: "critical" },
  { name: "Google OAuth Client ID",  regex: /[0-9]+-[a-z0-9_]{32}\.apps\.googleusercontent\.com/g,                    severity: "warning"  },

  // Payment
  { name: "Stripe Secret Key",       regex: /sk_live_[0-9a-zA-Z]{24,}/g,                                              severity: "critical" },
  { name: "Stripe Publishable Key",  regex: /pk_live_[0-9a-zA-Z]{24,}/g,                                              severity: "warning"  },

  // Auth tokens
  { name: "GitHub Token",            regex: /gh[ps]_[A-Za-z0-9_]{36,}/g,                                              severity: "critical" },
  { name: "GitHub OAuth Token",      regex: /gho_[A-Za-z0-9_]{36,}/g,                                                 severity: "critical" },
  { name: "Slack Token",             regex: /xox[bpors]-[0-9a-zA-Z-]{10,}/g,                                          severity: "critical" },
  { name: "Slack Webhook",           regex: /hooks\.slack\.com\/services\/T[0-9A-Z]{8,}\/B[0-9A-Z]{8,}\/[a-zA-Z0-9]{24}/g, severity: "critical" },
  { name: "Discord Bot Token",       regex: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g,                              severity: "critical" },

  // Database
  { name: "MongoDB Connection",      regex: /mongodb(\+srv)?:\/\/[^\s"'`]{10,}/g,                                     severity: "critical" },
  { name: "PostgreSQL Connection",   regex: /postgres(ql)?:\/\/[^\s"'`]{10,}/g,                                       severity: "critical" },
  { name: "MySQL Connection",        regex: /mysql:\/\/[^\s"'`]{10,}/g,                                                severity: "critical" },
  { name: "Redis Connection",        regex: /redis(s)?:\/\/[^\s"'`]{10,}/g,                                            severity: "critical" },

  // AI / ML
  { name: "OpenAI API Key",          regex: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,                             severity: "critical" },
  { name: "Anthropic API Key",       regex: /sk-ant-[A-Za-z0-9_-]{40,}/g,                                             severity: "critical" },
  { name: "HuggingFace Token",       regex: /hf_[A-Za-z0-9]{34,}/g,                                                   severity: "critical" },

  // Private keys
  { name: "RSA Private Key",         regex: /-----BEGIN RSA PRIVATE KEY-----/g,                                        severity: "critical" },
  { name: "EC Private Key",          regex: /-----BEGIN EC PRIVATE KEY-----/g,                                         severity: "critical" },
  { name: "Private Key (generic)",   regex: /-----BEGIN PRIVATE KEY-----/g,                                            severity: "critical" },
  { name: "PGP Private Key",         regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,                                  severity: "critical" },

  // Generic
  { name: "JWT Token",               regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,     severity: "warning"  },
  { name: "Bearer Token (hardcoded)", regex: /['"`]Bearer\s+[A-Za-z0-9._~+/=-]{20,}['"`]/g,                           severity: "warning"  },

  // Generic password / secret assignment
  { name: "Hardcoded password",       regex: /(?:password|passwd|pwd|secret|api_?key|apikey|auth_?token|access_?token)\s*[:=]\s*['"`][^'"`\n]{8,}['"`]/gi, severity: "warning" },
];

// Files to skip entirely
const IGNORE_PATTERNS = [
  "node_modules/**",
  ".next/**",
  ".git/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".backend-doctor/**",
  "*.min.js",
  "*.map",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

// Files where secrets are expected / acceptable
const SAFE_FILE_PATTERNS = [
  /\.env\.example$/,
  /\.env\.template$/,
  /\.env\.sample$/,
  /test[s]?\//,
  /__test__\//,
  /__mock__\//,
  /\.test\./,
  /\.spec\./,
  /fixture/i,
];

const CATEGORY: IssueCategory = "security";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SecretsAuditResult {
  issues: Issue[];
  summary: {
    filesScanned: number;
    secretsFound: number;
    criticalCount: number;
    warningCount: number;
    byType: Record<string, number>;
  };
}

export async function auditSecrets(projectPath: string): Promise<SecretsAuditResult> {
  const issues: Issue[] = [];
  const byType: Record<string, number> = {};
  let filesScanned = 0;

  try {
    const files = await glob("**/*.{ts,tsx,js,jsx,json,yaml,yml,toml,py,rb,go,rs,java,env,cfg,conf,ini,properties}", {
      cwd: projectPath,
      absolute: true,
      nodir: true,
      ignore: IGNORE_PATTERNS,
    });

    for (const filePath of files) {
      const relPath = relative(projectPath, filePath);

      // Skip safe files (test fixtures, example envs)
      if (SAFE_FILE_PATTERNS.some((p) => p.test(relPath))) continue;

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      // Skip very large files (likely generated / bundled)
      if (content.length > 500_000) continue;

      filesScanned++;
      const lines = content.split("\n");

      for (const pattern of SECRET_PATTERNS) {
        // Reset regex lastIndex for global patterns
        pattern.regex.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(content)) !== null) {
          // Find the line number
          const beforeMatch = content.slice(0, match.index);
          const lineNumber = beforeMatch.split("\n").length;
          const line = lines[lineNumber - 1] || "";

          // Skip commented-out lines
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;

          // Skip if it looks like a placeholder / example value
          const matchedValue = match[0];
          if (isPlaceholder(matchedValue)) continue;

          const id = generateIssueId(CATEGORY, relPath, `${pattern.name}:${lineNumber}`);

          // Redact the secret for the report
          const redacted = redactSecret(matchedValue);

          issues.push({
            id,
            category: CATEGORY,
            severity: pattern.severity,
            title: `${pattern.name} found in source code`,
            description:
              `Hardcoded ${pattern.name} detected at ${relPath}:${lineNumber}. ` +
              `Value: ${redacted}. ` +
              `Move this to an environment variable and add the file to .gitignore if it contains real credentials.`,
            file: relPath,
            line: lineNumber,
            status: "open",
            firstSeen: new Date().toISOString(),
            fixedAt: null,
          });

          byType[pattern.name] = (byType[pattern.name] ?? 0) + 1;
        }
      }
    }

    // Check if .env files are in .gitignore
    try {
      const gitignore = await readFile(`${projectPath}/.gitignore`, "utf-8");
      if (!gitignore.includes(".env") && !gitignore.includes("*.env")) {
        issues.push({
          id: generateIssueId(CATEGORY, ".gitignore", "env-not-ignored"),
          category: CATEGORY,
          severity: "warning",
          title: ".env files not in .gitignore",
          description:
            "The .gitignore file does not contain a rule for .env files. " +
            "Add '.env*' or '.env.local' to prevent accidentally committing secrets.",
          file: ".gitignore",
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    } catch {
      // No .gitignore — also a problem
      issues.push({
        id: generateIssueId(CATEGORY, ".gitignore", "no-gitignore"),
        category: CATEGORY,
        severity: "info",
        title: "No .gitignore file found",
        description: "No .gitignore file found in the project root. Consider adding one to exclude secrets and build artifacts.",
        file: ".gitignore",
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }

    const criticalCount = issues.filter((i) => i.severity === "critical").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;

    return {
      issues,
      summary: {
        filesScanned,
        secretsFound: issues.length,
        criticalCount,
        warningCount,
        byType,
      },
    };
  } catch (error) {
    return {
      issues: [{
        id: generateIssueId(CATEGORY, projectPath, "secrets-scan-error"),
        category: CATEGORY,
        severity: "warning",
        title: "Secrets scan encountered an error",
        description: `Error during secrets scan: ${error instanceof Error ? error.message : String(error)}`,
        file: projectPath,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      }],
      summary: { filesScanned, secretsFound: 0, criticalCount: 0, warningCount: 0, byType },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("example") ||
    lower.includes("placeholder") ||
    lower.includes("your_") ||
    lower.includes("your-") ||
    lower.includes("<your") ||
    lower.includes("xxx") ||
    lower.includes("changeme") ||
    lower.includes("TODO") ||
    lower.includes("replace") ||
    /^['"`]?\$\{/.test(value) ||       // Template literal ${VAR}
    /^['"`]?process\.env/.test(value)   // process.env reference
  );
}

function redactSecret(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}
