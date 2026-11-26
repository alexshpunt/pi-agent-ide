import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverAll } from "#unity/backend.ts";

void test("discovery retains local and remote results when another SSH host fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-discovery-"));
  const previous = { ...process.env };
  try {
    await mkdir(path.join(root, "agent", "pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(root, "agent", "pi-agent-ide", "ssh.json"),
      JSON.stringify({
        targets: [
          { id: "studio", host: "working", workspace: "/projects" },
          { id: "offline", host: "offline", workspace: "/projects" },
        ],
      }),
    );
    await writeFile(
      path.join(root, "unity"),
      `#!/usr/bin/env node
const data = process.argv[2] === 'status' ? {instances:[{projectPath:'/local/Game',pid:10,port:123,state:'ready'}]} : {projects:[{path:'/local/Game'}]};
console.log(JSON.stringify({success:true,data}));
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "ssh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2); if (args.at(-2) === 'offline') process.exit(255);
const argv = JSON.parse(Buffer.from(args.at(-1).match(/b64decode\\("([A-Za-z0-9+/=]+)"\\)/)[1], 'base64'));
const data = argv[1] === 'status' ? {instances:[{projectPath:'/projects/Game',pid:20,port:456,state:'ready'}]} : {projects:[{path:'/projects/Game'}]};
console.log(JSON.stringify({success:true,data}));
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${root}${path.delimiter}${previous.PATH}`;
    process.env.PI_UNITY_CLI = path.join(root, "unity");
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    for (const kind of ["editors", "projects"] as const) {
      const result = await discoverAll(kind);
      assert.equal(result.length, 3);
      assert.equal(result[0].kind, "local");
      assert.equal(result[0].target, "local");
      assert.ok(result[0].data);
      assert.equal(result[1].kind, "ssh");
      assert.equal(result[1].target, "studio");
      assert.ok(result[1].data);
      assert.equal(result[2].target, "offline");
      assert.ok(result[2].error);
      if (kind === "editors")
        assert.equal(
          (result[1].data as { projectPath: string }[])[0].projectPath,
          "ssh://studio/projects/Game",
        );
    }
  } finally {
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
