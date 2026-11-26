import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callTool, listTools } from "#unity/backend.ts";

void test("a remote call stays on the selected SSH host through discovery and MCP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-ssh-test-"));
  const old = { ...process.env };
  try {
    await mkdir(path.join(root, "agent", "pi-agent-ide"), { recursive: true });
    const settings = path.join(root, "agent", "pi-agent-ide", "ssh.json");
    const config = (host: string) =>
      JSON.stringify({ targets: [{ id: "studio", host, workspace: "/projects" }] });
    await writeFile(settings, config("host-one"));
    const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.at(-2) !== 'host-one') process.exit(9);
const payload = args.at(-1).match(/b64decode\\("([A-Za-z0-9+/=]+)"\\)/)[1];
const argv = JSON.parse(Buffer.from(payload, 'base64'));
if (argv[0] === 'wslpath') { console.log('/mnt/c/projects/Game'); }
else if (argv[1] === 'status') {
  fs.writeFileSync(process.env.TEST_SETTINGS, process.env.TEST_REPLACEMENT);
  console.log(JSON.stringify({success:true,data:{instances:[{projectPath:process.env.TEST_WINDOWS ? 'C:\\\\projects\\\\Game' : '/projects/Game',pid:42,port:1234,state:'ready'}]}}));
} else if (argv[1] === 'mcp' && argv[3] === '42') {
  const rl = require('node:readline').createInterface({input:process.stdin});
  rl.on('line', line => { const m = JSON.parse(line); if (!('id' in m)) return;
    const result = m.method === 'initialize' ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}} : m.method === 'tools/list' ? {tools:[{name:'read_scene',description:'scene',inputSchema:{type:'object'}}]} : {content:[{type:'text',text:'correct editor'}]};
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });
} else process.exit(8);
`;
    await writeFile(path.join(root, "ssh"), mock, { mode: 0o755 });
    process.env.PATH = `${root}${path.delimiter}${old.PATH}`;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    process.env.TEST_SETTINGS = settings;
    process.env.TEST_REPLACEMENT = config("host-two");
    assert.deepEqual(
      (await listTools("ssh://studio/projects/Game")).map((v) => {
        assert.ok(v && typeof v === "object" && "name" in v);
        return v.name;
      }),
      ["read_scene"],
    );
    await writeFile(settings, config("host-one"));
    const result = await callTool("ssh://studio/projects/Game", "read_scene", {});
    assert.deepEqual(result, { content: [{ type: "text", text: "correct editor" }] });
    await writeFile(settings, config("host-one"));
    process.env.TEST_WINDOWS = "1";
    assert.deepEqual(
      (await listTools("ssh://studio/mnt/c/projects/Game")).map((v) => {
        assert.ok(v && typeof v === "object" && "name" in v);
        return v.name;
      }),
      ["read_scene"],
    );
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
