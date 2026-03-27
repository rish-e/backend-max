# Contributing to Backend Max

Thanks for your interest in improving Backend Max! This guide will get you up and running.

## 🛠️ Development Setup

```bash
# Clone your fork
git clone https://github.com/<your-username>/backend-max.git
cd backend-max

# Install dependencies
npm install

# Build
npm run build

# Run in development mode (watch + rebuild)
npm run dev
```

### Testing with Claude Code

Point your Claude Code MCP config at your local build:

```jsonc
{
  "mcpServers": {
    "backend-max": {
      "command": "node",
      "args": ["/path/to/your/clone/dist/index.js"],
      "transport": "stdio"
    }
  }
}
```

Then open Claude Code in a test project and run `/doctor` to verify everything works.

## 🔍 Adding a New Analyzer

Analyzers live in `src/analyzers/`. Each one implements a standard interface:

1. **Create the file** — `src/analyzers/my-analyzer.ts`
2. **Implement the `Analyzer` interface:**

```typescript
import { Analyzer, AnalyzerResult, ProjectContext } from '../types.js';

export const myAnalyzer: Analyzer = {
  name: 'my-analyzer',
  category: 'security', // or: contracts, validation, errorHandling, envVars, performance

  async analyze(context: ProjectContext): Promise<AnalyzerResult[]> {
    const issues: AnalyzerResult[] = [];

    // Your analysis logic using ts-morph, AST traversal, etc.

    return issues;
  },
};
```

3. **Register it** in `src/analyzers/index.ts`
4. **Add tests** in `src/analyzers/__tests__/my-analyzer.test.ts`

## 📐 Code Style

- **TypeScript strict mode** — no `any`, no implicit returns
- **ESM imports** — use `.js` extensions in import paths
- **JSDoc comments** — document all exported functions and types
- **Descriptive names** — `findMissingAuthMiddleware`, not `check3`
- **Small functions** — each function does one thing

## 🔀 Pull Request Process

1. Create a feature branch from `main` (`git checkout -b feat/my-feature`)
2. Make your changes with clear, atomic commits
3. Ensure the project builds cleanly (`npm run build`)
4. Open a PR with:
   - A clear title describing the change
   - A description of *what* and *why*
   - Any relevant issue numbers
5. Wait for review — we aim to respond within 48 hours

## 💬 Questions?

Open a [GitHub Discussion](https://github.com/rishi-kolisetty/backend-max/discussions) or reach out in an issue. We're happy to help!
