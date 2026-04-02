# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 2.x     | Yes                |
| < 2.0   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability in Backend Max, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email **rishi@backendmax.dev** with:

1. A description of the vulnerability
2. Steps to reproduce the issue
3. The potential impact
4. Any suggested fixes (optional)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Resolution target**: Within 30 days for critical issues

## Security Design

Backend Max is a **read-only diagnostic tool** by design. It analyzes source code via static analysis and does not:

- Execute user code
- Make network requests to external services (except `live_test` which is opt-in and localhost-only)
- Modify source files (except `fix_issue` which generates patches for review)
- Send telemetry or analytics

### Path Safety

The built-in Path Guardian prevents scanning of:
- System directories (`/etc`, `/usr`, `~/.ssh`, `~/.aws`, etc.)
- Credential files (`.pem`, `.key`, `.env` values)
- Node modules and build outputs

### Output Sanitization

All diagnostic output is sanitized to strip:
- Environment variable values
- API keys and tokens
- Credit card numbers
- Bearer tokens
