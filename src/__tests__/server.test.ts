/**
 * MCP Server integration test.
 *
 * IMPORTANT: This test requires `npm run build` to have been run first
 * so that `dist/server.js` exists.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP Server", () => {
  it("starts and lists all tools", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/server.js"],
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();

    // Should have all 27 tools
    expect(tools.tools.length).toBeGreaterThanOrEqual(27);

    // Check some key tools exist
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("run_diagnosis");
    expect(toolNames).toContain("scan_routes");
    expect(toolNames).toContain("check_contracts");
    expect(toolNames).toContain("audit_security");
    expect(toolNames).toContain("fix_issue");
    expect(toolNames).toContain("live_test");
    expect(toolNames).toContain("trace_types");

    // Check tool annotations exist
    const runDiag = tools.tools.find((t) => t.name === "run_diagnosis");
    expect(runDiag?.annotations?.readOnlyHint).toBe(true);

    const fixTool = tools.tools.find((t) => t.name === "fix_issue");
    expect(fixTool?.annotations?.readOnlyHint).toBe(false);

    // Check prompts
    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((p) => p.name);
    expect(promptNames).toContain("backendmax");
    expect(promptNames).toContain("backend-security");
    expect(promptNames).toContain("backend-fix");

    await client.close();
  }, 15000);
});
