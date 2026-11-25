/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode } from "@toon-format/toon-v4";
import { run } from "#axi/cli.ts";
import { LinearPreflightCache } from "#axi/preflight-cache.ts";
import type { Runtime } from "#axi/types.ts";
import { createMcpRequestCountFixture, subtractCounts } from "./fixtures/mcp-request-count.ts";

const id = "3e628084-1d02-49d4-8654-2f28baa4fb70";
const args = (kind: string, reference: string, workspace = "example") => [
  "resources",
  "scope",
  kind,
  reference,
  "--workspace",
  workspace,
];

void test("separate CLI scope lookups reuse only identity proof and ordinary reads stay fresh", async (t) => {
  const fixture = await createMcpRequestCountFixture();
  t.after(() => fixture.close());
  const command = args("project", fixture.projectId, fixture.workspace);
  const first = await fixture.command(command);
  assert.deepEqual(first.project, {
    id: fixture.projectId,
    url: `https://linear.app/${fixture.workspace}/project/request-count-fixture`,
  });
  const before = fixture.snapshot();
  const second = await fixture.command(command);
  assert.deepEqual(second, first);
  assert.equal(subtractCounts(fixture.snapshot(), before).httpRequests, 0);
  assert.deepEqual(fixture.projectInputs, [{ query: fixture.projectId }]);
  await fixture.readProject();
  assert.equal(fixture.snapshot().project, before.project + 1);
  assert.equal(fixture.snapshot().workspace, before.workspace);
  // A different target cannot reuse the successful target proof.
  await assert.rejects(
    fixture.command(args("project", "00000000-0000-4000-8000-000000000000", fixture.workspace)),
  );
  assert.equal(fixture.snapshot().project, before.project + 2);
});

void test("concurrent cold CLI lookups share one workspace and scope proof", async (t) => {
  const fixture = await createMcpRequestCountFixture();
  t.after(() => fixture.close());
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      fixture.command(args("project", fixture.projectId, fixture.workspace)),
    ),
  );
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  const counts = fixture.snapshot();
  assert.equal(counts.workspace, 1);
  assert.equal(counts.toolsList, 1);
  assert.equal(counts.project, 1);
  assert.equal(counts.mutations, 0);
});
void test("a cached scope never authorizes another workspace", async (t) => {
  const fixture = await createMcpRequestCountFixture();
  t.after(() => fixture.close());
  await fixture.command(args("project", fixture.projectId, fixture.workspace));
  const before = fixture.snapshot();
  await assert.rejects(fixture.command(args("project", fixture.projectId, "other")));
  assert.equal(fixture.snapshot().project, before.project);
  assert.equal(fixture.snapshot().workspace, before.workspace + 1);
});

void test("scope proof is narrow, epoch-scoped and validates team and project identities", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let epoch = "a";
  let connectionId = "one";
  let now = 100000;
  let key = "ENG";
  let url = `https://linear.app/example/project/fixture-ab12cd34ef56`;
  const calls: Array<{ name: string; input: unknown }> = [];
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.test",
    preflightCache: new LinearPreflightCache({
      directory,
      scope: async () => ({ connectionId, epoch, server: "https://example.test" }),
      now: () => now,
    }),
    client: {
      listTools: async () => [
        {
          name: "get_team",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "get_project",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      callTool: async (name, input) => {
        calls.push({ name, input });
        return {
          structuredContent:
            name === "get_workspace"
              ? { url: "https://linear.app/example" }
              : name === "get_team"
                ? { id, key, description: "Not identity metadata" }
                : { id, url, description: "Not identity metadata", resources: ["Not metadata"] },
        };
      },
    },
  };
  const invoke = async (kind: string, reference: string) => {
    // A command runtime is recreated per invocation, as in separate CLI processes.
    runtime.preflightCache = new LinearPreflightCache({
      directory,
      now: () => now,
      scope: async () => ({ connectionId, epoch, server: "https://example.test" }),
    });
    return decode(await run(args(kind, reference), runtime));
  };
  assert.deepEqual(await invoke("team", "ENG"), { team: { id, key: "ENG" } });
  assert.deepEqual(await invoke("project", "ab12cd34ef56"), { project: { id, url } });
  await invoke("team", "ENG");
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["get_workspace", "get_team", "get_project"],
  );
  epoch = "b";
  await invoke("team", "ENG");
  assert.equal(calls.length, 5);
  connectionId = "two";
  await invoke("team", "ENG");
  assert.equal(calls.length, 7);
  now += 300001;
  key = "OTHER";
  await assert.rejects(invoke("team", "ENG"), /LINEAR_IDENTITY_MISMATCH/);
  key = "ENG";
  url = "https://linear.app/other/project/fixture-ab12cd34ef56";
  await assert.rejects(invoke("project", "ab12cd34ef56"), /LINEAR_IDENTITY_MISMATCH/);
  url = "https://linear.app/example/project/different-000000000000";
  await assert.rejects(invoke("project", "ab12cd34ef56"), /LINEAR_IDENTITY_MISMATCH/);
});
