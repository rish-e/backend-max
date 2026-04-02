// =============================================================================
// backend-max — External / remote site auditor
//
// Given a URL, probes the deployed application for security headers, TLS
// quality, exposed error details, and response characteristics — all without
// needing source code access.
// =============================================================================

import type { Issue, IssueCategory, Severity } from "../types.js";
import { generateIssueId } from "../utils/helpers.js";

const CATEGORY: IssueCategory = "security";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExternalAuditResult {
  url: string;
  issues: Issue[];
  headers: Record<string, string>;
  summary: {
    securityScore: number;   // 0–100
    headersPresent: string[];
    headersMissing: string[];
    serverInfo: string | null;
    tlsValid: boolean;
    responseTimeMs: number;
    statusCode: number | null;
    contentType: string | null;
  };
}

// ---------------------------------------------------------------------------
// Security headers we check for
// ---------------------------------------------------------------------------

interface HeaderCheck {
  header: string;
  severity: Severity;
  title: string;
  description: string;
  scorePenalty: number;
}

const REQUIRED_HEADERS: HeaderCheck[] = [
  {
    header: "strict-transport-security",
    severity: "critical",
    title: "Missing Strict-Transport-Security (HSTS)",
    description:
      "No HSTS header — browsers can be tricked into downgrading to HTTP. " +
      'Add: Strict-Transport-Security: max-age=31536000; includeSubDomains',
    scorePenalty: 15,
  },
  {
    header: "content-security-policy",
    severity: "warning",
    title: "Missing Content-Security-Policy (CSP)",
    description:
      "No CSP header — vulnerable to XSS and data injection attacks. " +
      "Add a Content-Security-Policy header with appropriate directives.",
    scorePenalty: 12,
  },
  {
    header: "x-frame-options",
    severity: "warning",
    title: "Missing X-Frame-Options",
    description:
      "No X-Frame-Options header — site can be embedded in iframes (clickjacking). " +
      "Add: X-Frame-Options: DENY or SAMEORIGIN.",
    scorePenalty: 10,
  },
  {
    header: "x-content-type-options",
    severity: "warning",
    title: "Missing X-Content-Type-Options",
    description:
      "No X-Content-Type-Options header — browsers may MIME-sniff responses. " +
      "Add: X-Content-Type-Options: nosniff",
    scorePenalty: 5,
  },
  {
    header: "referrer-policy",
    severity: "info",
    title: "Missing Referrer-Policy",
    description:
      "No Referrer-Policy header — full URLs may leak to third parties. " +
      "Add: Referrer-Policy: strict-origin-when-cross-origin",
    scorePenalty: 3,
  },
  {
    header: "permissions-policy",
    severity: "info",
    title: "Missing Permissions-Policy",
    description:
      "No Permissions-Policy header — browser features (camera, microphone, geolocation) not restricted. " +
      "Add: Permissions-Policy: camera=(), microphone=(), geolocation=()",
    scorePenalty: 3,
  },
  {
    header: "x-xss-protection",
    severity: "info",
    title: "Missing X-XSS-Protection",
    description:
      "No X-XSS-Protection header. While deprecated in modern browsers, " +
      "it still provides defense-in-depth for older browsers.",
    scorePenalty: 2,
  },
];

// Headers that shouldn't be exposed
const DANGEROUS_HEADERS = [
  { header: "x-powered-by",   title: "X-Powered-By header exposes server technology" },
  { header: "x-aspnet-version", title: "X-AspNet-Version header exposes framework version" },
  { header: "x-amz-error-code", title: "AWS error details exposed to clients" },
  { header: "x-amz-error-message", title: "AWS error messages exposed to clients" },
  { header: "x-amz-error-detail-key", title: "AWS S3 key paths exposed to clients" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function auditExternal(url: string): Promise<ExternalAuditResult> {
  const issues: Issue[] = [];
  const headersPresent: string[] = [];
  const headersMissing: string[] = [];
  let securityScore = 100;
  let responseHeaders: Record<string, string> = {};
  let statusCode: number | null = null;
  let responseTimeMs = 0;

  try {
    // Normalize URL
    let targetUrl = url.trim();
    if (!targetUrl.startsWith("http")) targetUrl = `https://${targetUrl}`;

    // Fetch with timing
    const start = Date.now();
    const response = await fetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "BackendMax-Auditor/2.2.0",
        "Accept": "text/html,application/json,*/*",
        "Accept-Encoding": "gzip, br",
      },
    });
    responseTimeMs = Date.now() - start;
    statusCode = response.status;

    // Collect all headers
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    // --- Check required security headers ---
    for (const check of REQUIRED_HEADERS) {
      const headerValue = responseHeaders[check.header];
      if (headerValue) {
        headersPresent.push(check.header);
      } else {
        headersMissing.push(check.header);
        securityScore -= check.scorePenalty;
        issues.push({
          id: generateIssueId(CATEGORY, targetUrl, check.header),
          category: CATEGORY,
          severity: check.severity,
          title: check.title,
          description: check.description,
          file: targetUrl,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }

    // --- Check dangerous/information-leaking headers ---
    for (const dh of DANGEROUS_HEADERS) {
      if (responseHeaders[dh.header]) {
        securityScore -= 5;
        issues.push({
          id: generateIssueId(CATEGORY, targetUrl, dh.header),
          category: CATEGORY,
          severity: "warning",
          title: dh.title,
          description:
            `The response includes ${dh.header}: ${responseHeaders[dh.header]}. ` +
            "This leaks internal infrastructure details to attackers. Remove or suppress this header.",
          file: targetUrl,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }

    // --- Check Server header ---
    const serverHeader = responseHeaders["server"];
    if (serverHeader) {
      // Detailed server info is a risk
      if (/\d+\.\d+/.test(serverHeader)) {
        securityScore -= 3;
        issues.push({
          id: generateIssueId(CATEGORY, targetUrl, "server-version"),
          category: CATEGORY,
          severity: "info",
          title: "Server header reveals version information",
          description:
            `Server header: "${serverHeader}". Version numbers help attackers target known vulnerabilities. ` +
            "Configure your server/CDN to suppress or generalize this header.",
          file: targetUrl,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }
    }

    // --- Check caching ---
    const cacheControl = responseHeaders["cache-control"];
    if (cacheControl === "max-age=0" || !cacheControl) {
      issues.push({
        id: generateIssueId(CATEGORY, targetUrl, "no-cache"),
        category: "caching" as IssueCategory,
        severity: "info",
        title: "No effective caching configured",
        description:
          `Cache-Control is "${cacheControl || "absent"}". ` +
          "Static assets should have long cache lifetimes with content hashing. " +
          "Consider: cache-control: public, max-age=31536000, immutable for hashed assets.",
        file: targetUrl,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }

    // --- Check HTTPS redirect ---
    if (targetUrl.startsWith("https://")) {
      try {
        const httpUrl = targetUrl.replace("https://", "http://");
        const httpResp = await fetch(httpUrl, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        });
        if (httpResp.status !== 301 && httpResp.status !== 308) {
          securityScore -= 5;
          issues.push({
            id: generateIssueId(CATEGORY, targetUrl, "no-https-redirect"),
            category: CATEGORY,
            severity: "warning",
            title: "HTTP does not redirect to HTTPS",
            description:
              `HTTP request to ${httpUrl} returned ${httpResp.status} instead of 301/308 redirect to HTTPS. ` +
              "Configure your server to permanently redirect all HTTP traffic to HTTPS.",
            file: targetUrl,
            line: null,
            status: "open",
            firstSeen: new Date().toISOString(),
            fixedAt: null,
          });
        }
      } catch {
        // HTTP port may be closed — that's actually fine
      }
    }

    // --- Check response time ---
    if (responseTimeMs > 3000) {
      issues.push({
        id: generateIssueId("performance" as IssueCategory, targetUrl, "slow-response"),
        category: "performance" as IssueCategory,
        severity: "warning",
        title: "Slow response time",
        description: `Response took ${responseTimeMs}ms. Target under 1000ms for good user experience.`,
        file: targetUrl,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      });
    }

    // --- Check for error probing (404 page) ---
    try {
      const probeUrl = new URL("/this-page-does-not-exist-404-probe", targetUrl).toString();
      const probeResp = await fetch(probeUrl, {
        signal: AbortSignal.timeout(5_000),
        headers: { "User-Agent": "BackendMax-Auditor/2.2.0" },
      });
      const probeBody = await probeResp.text();

      // Check if 404 leaks stack traces or debug info
      if (
        probeBody.includes("stack trace") ||
        probeBody.includes("at Module") ||
        probeBody.includes("Error:") ||
        probeBody.includes("Traceback")
      ) {
        securityScore -= 8;
        issues.push({
          id: generateIssueId(CATEGORY, targetUrl, "error-leak"),
          category: CATEGORY,
          severity: "warning",
          title: "Error page leaks debug information",
          description:
            "The 404/error page contains stack traces or debug information visible to users. " +
            "Configure custom error pages in production to prevent information leakage.",
          file: probeUrl,
          line: null,
          status: "open",
          firstSeen: new Date().toISOString(),
          fixedAt: null,
        });
      }

      // Check if S3/cloud error details leak
      const probeHeaders: Record<string, string> = {};
      probeResp.headers.forEach((v, k) => { probeHeaders[k.toLowerCase()] = v; });
      for (const dh of DANGEROUS_HEADERS) {
        if (probeHeaders[dh.header] && !responseHeaders[dh.header]) {
          issues.push({
            id: generateIssueId(CATEGORY, targetUrl, `404-${dh.header}`),
            category: CATEGORY,
            severity: "warning",
            title: `${dh.title} (on error pages)`,
            description:
              `Error responses expose ${dh.header}: ${probeHeaders[dh.header]}. ` +
              "Configure custom error responses on your CDN/server to suppress internal headers.",
            file: probeUrl,
            line: null,
            status: "open",
            firstSeen: new Date().toISOString(),
            fixedAt: null,
          });
        }
      }
    } catch {
      // Probe failed — not critical
    }

    securityScore = Math.max(0, securityScore);

    return {
      url: targetUrl,
      issues,
      headers: responseHeaders,
      summary: {
        securityScore,
        headersPresent,
        headersMissing,
        serverInfo: serverHeader ?? null,
        tlsValid: targetUrl.startsWith("https://"),
        responseTimeMs,
        statusCode,
        contentType: responseHeaders["content-type"] ?? null,
      },
    };
  } catch (error) {
    return {
      url,
      issues: [{
        id: generateIssueId(CATEGORY, url, "fetch-failed"),
        category: CATEGORY,
        severity: "warning",
        title: "External audit failed — could not reach URL",
        description: `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
        file: url,
        line: null,
        status: "open",
        firstSeen: new Date().toISOString(),
        fixedAt: null,
      }],
      headers: responseHeaders,
      summary: {
        securityScore: 0,
        headersPresent: [],
        headersMissing: REQUIRED_HEADERS.map((h) => h.header),
        serverInfo: null,
        tlsValid: false,
        responseTimeMs,
        statusCode,
        contentType: null,
      },
    };
  }
}
