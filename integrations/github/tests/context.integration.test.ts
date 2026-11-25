import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import {
  contextArchive,
  contextBase,
  contextHead,
  initialContextState,
  type ContextFixtureState,
} from "./fixtures/context-provider.ts";

import { githubPackageRoot as root } from "./fixtures/package-root.ts";
const fixture = path.join(root, "tests/fixtures/context-provider.ts");
const rendered = (result: ContextFixtureState["calls"][number]["result"]) =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
async function sourceProof() {
  const names = (await readdir(path.join(root, "src")))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const hashes = await Promise.all(
    names.map(
      async (name) =>
        [
          name,
          createHash("sha256")
            .update(await readFile(path.join(root, "src", name)))
            .digest("hex"),
        ] as const,
    ),
  );
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(typeof version, "string");
  return { version, source: root, hashes: Object.fromEntries(hashes) };
}

// Pattern: extensions example with the repository's shared-tool nested probe fixture.
// Contract: linked CI/Project/file context is navigable through real Pi without mutating HTTP or widened Search scopes.
test("real Pi follows readonly PR CI Project and browser context through shared tools", async () => {
  const ide = await currentIde();
  const source = await sourceProof();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "github-context-"));
  await writeFile(path.join(cwd, "context-fixture.json"), JSON.stringify(initialContextState()));
  let directory: string | undefined;
  try {
    const result = await new PiIntegrationTest({
      testName: "github-resource-context",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [ide.extension, fixture],
      isolateUserResources: true,
      rawMode: false,
      tools: ["read", "search", "verify_context_navigation"],
      timeoutMs: 90_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "context-guide",
              name: "read",
              arguments: { path: "docs:github-context" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "context-probe", name: "verify_context_navigation", arguments: {} })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished the controlled context navigation.")]),
      ],
    }).run(
      "Follow verified GitHub context links using ordinary Read and bounded Search. Do not execute workflows or mutate any resource.",
    );
    directory = result.artifacts.directory;
    const state = JSON.parse(
      await readFile(path.join(cwd, "context-fixture.json"), "utf8"),
    ) as ContextFixtureState;
    await writeFile(
      path.join(directory, "http-fixture-state.json"),
      JSON.stringify(state, null, 2),
    );
    await writeFile(path.join(directory, "provider-source.json"), JSON.stringify(source, null, 2));
    await ide.record(directory);
    expect(await sourceProof()).toEqual(source);
    expect(
      getToolExecution(result, "context-guide").isError,
      getToolResultText(result, "context-guide"),
    ).toBe(false);
    expect(
      getToolExecution(result, "context-probe").isError,
      getToolResultText(result, "context-probe"),
    ).toBe(false);
    const successfulCall = (label: string) => {
      const call = state.calls.find((value) => value.label === label);
      assert.ok(call, label);
      expect(call.isError, rendered(call.result)).toBe(false);
      return call;
    };
    const output = (label: string) => rendered(successfulCall(label).result);
    expect(output("checks")).toContain(`Head SHA: ${contextHead}`);
    expect(output("runs")).toContain("Build");
    expect(output("run")).toContain("conclusion: failure");
    expect(output("job")).toContain("Compile: completed / failure");
    expect(output("job-browser")).toContain("id: 8");
    expect(output("log")).toContain("compile-failure-marker");
    expect(output("artifact")).toContain("failure-proof");
    const archive = successfulCall("archive");
    const archivePath = archive.args.path;
    assert.ok(typeof archivePath === "string");
    expect(rendered(archive.result)).toContain(`raw:${archivePath}`);
    expect(successfulCall("archive-window").result.details).toMatchObject({
      byteOffset: 2,
      byteLength: 3,
      totalBytes: contextArchive.length,
    });
    expect(output("archive-window")).toContain("03 04 ff");
    expect(output("project-fields")).toContain("Status");
    expect(output("project-items")).toContain("github://other/repo/issues/3");
    expect(output("project-issue-body")).toContain("Linked Project issue body");
    expect(output("tree")).toContain(`Commit: ${contextHead}`);
    expect(output("exact-file")).toContain("outside-file-marker");
    expect(output("blob-lines")).toContain("selected-file-marker");
    expect(output("blob-lines")).not.toContain("outside-file-marker");
    expect(output("selected-search")).toContain("RESULT#");
    expect(output("selected-match")).toContain("selected-file-marker");
    expect(output("selected-match")).not.toContain("outside-file-marker");
    expect(successfulCall("outside-search").result.details).toMatchObject({
      payload: { mode: "text", matches: [], complete: true },
    });
    expect(output("commit")).toContain("Fixture commit");
    expect(output("compare")).toContain(`file?ref=${contextHead}`);
    for (const [label, code] of [
      ["wrong-owner", "GH_IDENTITY_MISMATCH"],
      ["ambiguous-file", "GH_AMBIGUOUS_REF"],
    ]) {
      const call = state.calls.find((value) => value.label === label);
      assert.ok(call, label);
      expect(call.isError, label).toBe(true);
      expect(rendered(call.result)).toContain(code);
    }
    const rest = state.requests.filter((request) => request.path !== "/graphql");
    expect(rest.every((request) => request.method === "GET")).toBe(true);
    expect(state.requests.filter((request) => request.path === "/graphql")).toHaveLength(3);
    expect(
      state.requests
        .filter((request) => request.path === "/graphql")
        .every(
          (request) =>
            request.method === "POST" && !/\bmutation\b/u.test(String(request.body?.query)),
        ),
    ).toBe(true);
    expect(
      state.requests
        .filter((request) => request.host === "api.github.com")
        .every((request) => request.authenticated),
    ).toBe(true);
    expect(
      state.requests
        .filter((request) => request.host === "objects.githubusercontent.com")
        .every((request) => !request.authenticated),
    ).toBe(true);
    expect(
      state.requests.every((request) =>
        ["api.github.com", "objects.githubusercontent.com"].includes(request.host),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) => request.path.endsWith("/dispatches") || request.path.endsWith("/rerun"),
      ),
    ).toBe(false);
    expect(
      state.requests.some(
        (request) =>
          request.path === `/repos/example/project/compare/${contextBase}...${contextHead}`,
      ),
    ).toBe(true);
    expect(JSON.stringify(state.calls)).not.toContain("private-context-fixture-token");
  } finally {
    if (!directory) {
      // Preserve the HTTP boundary if process startup failed before a PiRun was returned.
      const failureDirectory = path.join(
        testArtifactsDir(import.meta.filename),
        "github-resource-context",
      );
      await mkdir(failureDirectory, { recursive: true });
      await writeFile(
        path.join(failureDirectory, "http-fixture-state.json"),
        await readFile(path.join(cwd, "context-fixture.json")),
      );
      await writeFile(
        path.join(failureDirectory, "provider-source.json"),
        JSON.stringify(source, null, 2),
      );
    }
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
