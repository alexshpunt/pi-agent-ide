/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord, isUnknownArray } from "#axi/types.ts";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";
import {
  createMcpRequestCountFixture,
  subtractCounts,
  usefulMethodCounts,
} from "./fixtures/mcp-request-count.ts";

type Fixture = Awaited<ReturnType<typeof createMcpRequestCountFixture>>;
function assertProjectRead(fixture: Fixture, result: Awaited<ReturnType<Fixture["readProject"]>>) {
  const capabilities = fixtureRecord(result.capabilities.capabilities);
  assert.equal(capabilities.workspace, fixture.workspace);
  assert(isUnknownArray(capabilities.items));
  assert.ok(capabilities.items.some((item) => isRecord(item) && item.name === "get_project"));
  assert.equal(result.invocation.effect, "applied");
  assert.equal(result.invocation.operation, "get_project");
  assert.equal(result.invocation.workspace, fixture.workspace);
  assert.equal(jsonRecord(result.invocation.data).id, fixture.projectId);
}

// The frontend acquires capabilities and invokes the resource through separate actual CLI processes.
void test(
  "separate CLI project reads reuse discovery and workspace proof instead of multiplying requests",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    const first = await fixture.readProject();
    assertProjectRead(fixture, first);
    const cold = fixture.snapshot();
    const second = await fixture.readProject();
    assertProjectRead(fixture, second);
    const warm = subtractCounts(fixture.snapshot(), cold);
    t.diagnostic(
      JSON.stringify({
        cold,
        warm,
        mcpMethodCounts: { cold: usefulMethodCounts(cold), warm: usefulMethodCounts(warm) },
      }),
    );

    assert.ok(cold.initialize > 0);
    assert.ok(cold.httpRequests > cold.toolsList + cold.workspace + cold.project);
    assert.deepEqual(usefulMethodCounts(cold), { toolsList: 1, workspace: 1, project: 1 });
    assert.deepEqual(usefulMethodCounts(warm), { toolsList: 0, workspace: 0, project: 1 });
  },
);

void test(
  "concurrent cold CLI readers share one discovery and workspace verification",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    const reads = await Promise.all(Array.from({ length: 3 }, () => fixture.readProject()));
    for (const result of reads) assertProjectRead(fixture, result);
    const counts = fixture.snapshot();
    t.diagnostic(
      JSON.stringify({
        concurrentReaders: reads.length,
        counts,
        mcpMethodCounts: usefulMethodCounts(counts),
      }),
    );
    assert.deepEqual(usefulMethodCounts(counts), { toolsList: 1, workspace: 1, project: 3 });
  },
);

void test(
  "an uncompilable cached output schema blocks the real CLI before any mutation",
  { timeout: 40_000 },
  async (t) => {
    const fixture = await createMcpRequestCountFixture();
    t.after(() => fixture.close());
    await fixture.readProject();
    assert(fixture.environment.LINEAR_AXI_CONNECTION_FILE);
    const directory = fixture.environment.LINEAR_AXI_CONNECTION_FILE + ".preflight";
    let corrupted = false;
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json") || name.endsWith(".rate.json")) continue;
      const file = path.join(directory, name);
      const entry = jsonRecord(await readFile(file, "utf8"));
      if (!isUnknownArray(entry.value)) continue;
      const tool = entry.value.find((value) => isRecord(value) && value.name === "save_comment");
      if (!isRecord(tool)) continue;
      tool.outputSchema = {
        type: "object",
        properties: { id: { $ref: "urn:missing-fixture-schema" } },
      };
      await writeFile(file, JSON.stringify(entry), { mode: 0o600 });
      corrupted = true;
    }
    assert.equal(corrupted, true);
    const before = fixture.snapshot();
    await assert.rejects(fixture.writeComment());
    const after = fixture.snapshot();
    assert.equal(after.mutationAttempts, 0);
    assert.equal(after.mutations, 0);
    assert.equal(after.httpRequests, before.httpRequests);
  },
);
