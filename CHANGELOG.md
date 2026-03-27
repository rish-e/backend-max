# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-03-27

### Added

- **MCP Server** — stdio transport for local Claude Code integration
- **Project Understanding** — intent-aware analysis that identifies domains, architecture, and purpose
- **Cross-Boundary Contract Verification** — detects URL, method, payload, and response mismatches between frontend and backend
- **6 Audit Engines:**
  - API Contract Drift detection
  - Error Handling analysis (try/catch coverage, consistent error formats)
  - Input Validation checking (Zod schema coverage, raw body access)
  - Environment Variable verification (missing vars, prefix misuse, undefined refs)
  - Security scanning (auth gaps, CORS config, injection patterns)
  - Performance analysis (N+1 queries, unbounded queries, payload bloat)
- **Living API Documentation** — auto-generated from route handlers, always current
- **Health Score** — composite 0–100 score with per-category breakdowns
- **Issue Lifecycle Tracking** — full ledger from discovery through fix and verification
- **`/doctor` Slash Command** — single command to run the full diagnostic pipeline
- **Next.js App Router Support** — first-class support for Next.js 13+ App Router projects
- **`.backend-doctor/` Output Directory** — structured output with history, docs, and issue tracking

[1.0.0]: https://github.com/rishi-kolisetty/backend-max/releases/tag/v1.0.0
