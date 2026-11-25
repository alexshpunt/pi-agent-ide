import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractLinearMcpUrl, loadDotEnv, parseDotEnv } from "#axi/config.ts";

void test("Codex Linear MCP URL lookup stays inside linear table", () => {
  const text = `
[mcp_servers.linear]
command = "linear-mcp"

[mcp_servers.other]
url = "https://wrong.example/mcp"
`;

  assert.equal(extractLinearMcpUrl(text), null);
});

void test("Codex Linear MCP URL lookup reads the linear table URL", () => {
  const text = `
[mcp_servers.other]
url = "https://wrong.example/mcp"

[mcp_servers.linear]
url = "https://linear.example/mcp"
`;

  assert.equal(extractLinearMcpUrl(text), "https://linear.example/mcp");
});

void test("shared Pi dotenv values load while explicit environment wins", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "linear-axi-cwd-"));
  const piDir = await mkdtemp(join(tmpdir(), "linear-axi-pi-"));
  const configDir = join(piDir, "config", "linear-axi");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, ".env"),
    `LINEAR_AXI_CLIENT_ID=from-file\nLINEAR_AXI_CLIENT_SECRET="quoted-value"\n`,
  );

  const env = await loadDotEnv(
    { PI_CODING_AGENT_DIR: piDir, LINEAR_AXI_CLIENT_ID: "from-process" },
    cwd,
  );

  assert.equal(env.LINEAR_AXI_CLIENT_ID, "from-process");
  assert.equal(env.LINEAR_AXI_CLIENT_SECRET, "quoted-value");
});

void test("configured relative dotenv paths resolve from cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "linear-axi-cwd-"));
  await writeFile(join(cwd, "linear.env"), "LINEAR_AXI_TEAM=from-override\n");

  const env = await loadDotEnv({ LINEAR_AXI_ENV_FILE: "linear.env" }, cwd);

  assert.equal(env.LINEAR_AXI_TEAM, "from-override");
});

void test("dotenv parser supports export, comments, and escaped quotes", () => {
  assert.deepEqual(
    parseDotEnv('export LINEAR_AXI_ROLE=qa\nLINEAR_AXI_TEAM="pi \\"blue\\"" # comment\n'),
    { LINEAR_AXI_ROLE: "qa", LINEAR_AXI_TEAM: 'pi "blue"' },
  );
});
