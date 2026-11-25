import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
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
const fixture = path.join(root, "tests/fixtures/connections-provider.ts");
const body = "github://example/project/issues/12#body";

// Pattern: automatic-modes real-Pi fixtures plus native Codemode bounded composition.
// Contract: changing credentials retires old Read/Search/API contexts even for the same login.
test.each([
  ["standalone", "pat"],
  ["ide-first", "pat"],
  ["github-first", "pat"],
  ["standalone", "device"],
  ["standalone", "app"],
] as const)(
  "GitHub profile switches isolate retained contexts (%s, %s)",
  async (mode, kind) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/connections-integration-"));
    const file = path.join(cwd, "connections-fixture.json");
    let keyDirectory: string | undefined;
    if (kind === "app") {
      keyDirectory = await mkdtemp(path.join(tmpdir(), "lpt892-method-key-"));
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await writeFile(
        path.join(keyDirectory, "app.pem"),
        privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
    }
    await writeFile(
      file,
      JSON.stringify({
        body: "First line\nLast line\n",
        sequence: 0,
        requests: [],
        authKind: kind,
        ...(keyDirectory ? { privateKeyPath: path.join(keyDirectory, "app.pem") } : {}),
      }),
    );
    const ide = await currentIde();
    const prefix = mode === "standalone" ? "github_" : "";
    const extensions =
      mode === "standalone"
        ? [fixture]
        : mode === "ide-first"
          ? [ide.extension, fixture]
          : [fixture, ide.extension];
    const code = [
      `const before = await tools.${prefix}read({path:${JSON.stringify(body)},offset:1,limit:1});`,
      `await tools.${prefix}read({path:"https://api.github.com/repos/example/project/forbidden"});`,
      `const searched = await tools.${prefix}search({path:${JSON.stringify(body.replace("/12", "/13"))},query:"First line"}); if (!searched || searched.matches.length !== 1) throw new Error("Missing Search selection");`,
      `const receipt = await tools.${prefix}write({path:"github://api/rest",content:JSON.stringify({method:"GET",path:"/repos/example/project"})});`,
      'const apiSource = new RegExp("github:" + "/" + "/api/results/" + "[a-z0-9-]+", "i").exec(JSON.stringify(receipt))?.[0]; if(!apiSource)throw new Error("Missing API snapshot identity: " + JSON.stringify(receipt));',
      ...(mode === "standalone"
        ? []
        : [
            'if (!receipt || receipt.source !== apiSource || Object.keys(receipt).join() !== "source") throw new Error("Invalid Codemode action receipt: " + JSON.stringify(receipt));',
          ]),
      `for (const acquired of [before, searched]) { if (!acquired || !await tools.${prefix}read({path:acquired})) throw new Error("Missing reusable context before the profile switch"); }`,
      'await tools.fixture_switch({profile:"b"});',
      `for (const old of [before, searched]) { if (await tools.${prefix}replace({path:old,text:"Wrong profile"}) !== null) throw new Error("Old profile context remained writable"); }`,
      `if (await tools.${prefix}read({path:apiSource}) !== null) throw new Error("Old API snapshot survived switching");`,
      `const current = await tools.${prefix}read({path:${JSON.stringify(body)},offset:1,limit:1});`,
      'if (!current) throw new Error("Missing Read selection after the profile switch");',
      `await tools.${prefix}replace({path:current,text:"Updated"});`,
    ].join("\n");
    try {
      const result = await new PiIntegrationTest({
        testName: "github-connections-" + mode + (kind === "pat" ? "" : "-" + kind),
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        // Use a dedicated Pi process: the extension reads its fixture from cwd at load time.
        tuiSize: { cols: 160, rows: 50 },
        extensions: [...extensions, "builtin:tool-search", "builtin:codemode"],
        tools: [
          "tool_search",
          "codemode",
          "fixture_switch",
          ...(mode === "standalone" ? [] : ["read", "write", "search", "replace"]),
        ],
        timeoutMs: 60_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "discover",
                name: "tool_search",
                arguments: { query: "github", limit: 30 },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          ...(kind === "pat"
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "setup",
                      name: prefix + "read",
                      arguments: { path: "docs:github-setup" },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]
            : []),
          assistantMessage([toolCall({ id: "scope", name: "codemode", arguments: { code } })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [toolCall({ id: "verify", name: prefix + "read", arguments: { path: body } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "raw-race",
                name: prefix + "write",
                arguments: {
                  path: "github://api/rest",
                  content: JSON.stringify({
                    method: "POST",
                    path: "/repos/example/project/raw-cache-race",
                    body: { title: "one raw effect" },
                  }),
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "unknown",
                name: prefix + "write",
                arguments: {
                  path: "github://example/project/issues/new",
                  content: JSON.stringify({ title: "switch-unknown", body: "one effect" }),
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "denied",
                name: prefix + "read",
                arguments: { path: "https://api.github.com/repos/example/project/forbidden" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Switch the fixture connection explicitly; reject old scopes and never replay an uncertain write.",
      );
      for (const id of ["discover", "scope", "verify", ...(kind === "pat" ? ["setup"] : [])])
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      if (kind === "pat")
        expect(getToolExecutionDetails(getToolExecution(result, "setup"))).toMatchObject({
          documentation: { kind: "document", id: "github-setup" },
        });
      expect(getToolResultText(result, "scope")).toContain("GH_RESULT_EXPIRED");
      expect(getToolResultText(result, "verify")).toContain("Updated\nLast line");
      expect(getToolExecution(result, "raw-race").isError).toBe(true);
      expect(getToolResultText(result, "raw-race")).toContain("GH_RESULT_EXPIRED");
      expect(getToolResultText(result, "raw-race")).toContain("unknown");
      expect(getToolExecution(result, "unknown").isError).toBe(true);
      expect(getToolResultText(result, "unknown")).toContain("unknown");
      const state = JSON.parse(await readFile(file, "utf8")) as {
        body: string;
        oauthRefreshes?: string[];
        requests: { method: string; actor: string; route: string }[];
      };
      expect(state.body).toBe("Updated\nLast line\n");
      expect(state.requests.filter((request) => request.method === "PATCH")).toEqual([
        expect.objectContaining({ actor: "b" }),
      ]);
      expect(
        state.requests
          .filter((request) => request.method === "POST" && request.route.startsWith("/repos/"))
          .map((request) => request.route),
      ).toEqual(["/repos/example/project/raw-cache-race", "/repos/example/project/issues"]);
      expect(getToolExecution(result, "denied").isError).toBe(true);
      expect(getToolResultText(result, "denied")).toContain("GH_FORBIDDEN");
      expect(
        state.requests
          .filter((request) => request.route === "/repos/example/project/forbidden")
          .map((request) => request.actor),
      ).toEqual(["a", "b"]);
      if (kind === "device") expect(state.oauthRefreshes?.sort()).toEqual(["a", "b"]);
      await writeFile(
        path.join(
          testArtifactsDir(import.meta.filename),
          "github-connections-" + mode + (kind === "pat" ? "" : "-" + kind),
          "http-fixture-state.json",
        ),
        JSON.stringify(state, null, 2),
      );
      expect(JSON.stringify(result.messages)).not.toContain("fixture-private-");
      expect(result.tuiRenderedOutput).not.toContain("fixture-private-");
      for (const value of ["fixture-refresh-", "fixture-rotated-", "-----BEGIN PRIVATE KEY-----"]) {
        expect(JSON.stringify(result.messages)).not.toContain(value);
        expect(result.tuiRenderedOutput).not.toContain(value);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      if (keyDirectory) await rm(keyDirectory, { recursive: true, force: true });
    }
  },
  90_000,
);
