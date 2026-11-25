import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
import { githubPackageRoot } from "./fixtures/package-root.ts";

const root = githubPackageRoot;
const body = "github://example/project/issues/12#body";

// Pattern: the native Codemode/IDE fixture with a public Read-stage extension.
// Contract: A-acquired content cannot receive B-owned write authority during post-read.
test("GitHub Read keeps its acquisition owner when the profile changes before selection registration", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/connection-acquisition-"));
  const file = path.join(cwd, "connections-fixture.json");
  const content = "First line\nLast line\n";
  await writeFile(file, JSON.stringify({ body: content, sequence: 0, requests: [] }));
  const ide = await currentIde();
  const code = [
    `const acquired = await tools.read({path:${JSON.stringify(body)},offset:1,limit:1});`,
    "if (acquired !== null) {",
    '  const edited = await tools.replace({path:acquired,text:"Wrong profile"});',
    '  if (edited !== null) throw new Error("A-acquired Read became writable under profile B");',
    "}",
    'text("Read acquisition stayed with A; no old selection was writable as B");',
  ].join("\n");
  try {
    const result = await new PiIntegrationTest({
      testName: "github-read-acquisition-owner",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      // Use a dedicated Pi process: the extension reads its fixture from cwd at load time.
      tuiSize: { cols: 160, rows: 50 },
      extensions: [
        ide.extension,
        path.join(root, "tests/fixtures/connection-read-race-provider.ts"),
        "builtin:codemode",
      ],
      tools: ["codemode", "read", "replace"],
      timeoutMs: 60_000,
      conversation: [
        assistantMessage([toolCall({ id: "acquire", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([toolCall({ id: "fresh", name: "read", arguments: { path: body } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Reject a selection whose originating connection was retired while Read was finishing.");
    const state = JSON.parse(await readFile(file, "utf8")) as {
      body: string;
      requests: { method: string; route: string; actor: string }[];
    };
    expect(
      JSON.parse(await readFile(path.join(cwd, "read-acquisition-race.json"), "utf8")),
    ).toEqual({
      source: body,
      content,
      profileBeforeSwitch: "a",
      profileAfterSwitch: "b",
    });
    expect(state.requests).toContainEqual({
      method: "GET",
      route: "/repos/example/project/issues/12",
      actor: "a",
    });
    expect(state.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(state.body).toBe(content);
    expect(getToolExecution(result, "acquire").isError, getToolResultText(result, "acquire")).toBe(
      false,
    );
    expect(getToolResultText(result, "acquire")).toContain("no old selection was writable as B");
    expect(getToolResultText(result, "acquire")).toMatch(
      /- read[^\n]*\n[^\n]*GH_CONNECTION_CHANGED/u,
    );
    expect(getToolExecution(result, "fresh").isError, getToolResultText(result, "fresh")).toBe(
      false,
    );
    expect(getToolResultText(result, "fresh")).toContain("First line\nLast line");
    expect(state.requests).toContainEqual({
      method: "GET",
      route: "/repos/example/project/issues/12",
      actor: "b",
    });
    expect(JSON.stringify(result.messages)).not.toContain("fixture-private-");
    expect(result.tuiRenderedOutput).not.toContain("fixture-private-");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
