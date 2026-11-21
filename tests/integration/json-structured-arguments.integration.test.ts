import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { SshBackend } from "#src/backend/ssh.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);
type Call = Parameters<typeof toolCall>[0];
const literal = '{ "amount": 1.0, "items": [1, 2] }\n';
const files = {
  "source.txt": "head\nDATA\ntail\n",
  "target.txt": "left OLD right\n",
  "copy.txt": "left OLD right\n",
  "move.txt": "left OLD right\n",
  "edit.txt": "alpha\nbeta\ngamma\nomega\n",
  "a/main.ts": "export function jsonToken() { return 1; }\njsonToken();\n",
  "b/use.ts": 'import { jsonToken } from "#token";\njsonToken();\n',
  "skip.ts": "export function jsonToken() {}\n",
  "[broken": "malformed-source\n",
};

function calls(root: string, prefix: string, encoded: boolean): Call[] {
  const at = (file: string) => `${root}/${file}`;
  const composite = (value: JsonValue): JsonValue => (encoded ? JSON.stringify(value) : value);
  const ref = (id: string): JsonValue => ({ id: `$issued-uuid:${prefix}-${id}` });
  const sourceRef = (id: string): JsonValue => composite(ref(id));
  const call = (id: string, name: string, args: Record<string, JsonValue>): Call => ({
    id: `${prefix}-${id}`,
    name,
    arguments: args,
  });
  const listed = composite([at("a"), at("b")]);
  return [
    call("read", "read", { path: at("source.txt") }),
    call("reread", "read", { path: sourceRef("read") }),
    call("scoped", "search", { path: sourceRef("read"), query: "DATA" }),
    call("list", "read", {
      path: composite([at("source.txt"), at("target.txt")]),
      views: composite([]),
    }),
    call("search", "search", { path: listed, query: "jsonToken" }),
    call("files", "file_search", { path: listed, pattern: "*.ts" }),
    call("ast", "ast_search", { path: listed, pattern: "jsonToken($$$ARGS)" }),
    call("lsp", "lsp_search", { path: listed, query: "jsonToken" }),
    call("left", "search", { path: at("target.txt"), query: "OLD" }),
    call("copy", "copy", { path: sourceRef("scoped"), target: sourceRef("left") }),
    call("copy-destination", "search", { path: at("copy.txt"), query: "OLD" }),
    call("copy-range", "copy", {
      path: at("source.txt"),
      start: ref("scoped"),
      end: ref("scoped"),
      target: at("copy.txt"),
      targetStart: ref("copy-destination"),
      targetEnd: ref("copy-destination"),
    }),
    call("move-destination", "search", { path: at("move.txt"), query: "OLD" }),
    call("move", "move", { path: sourceRef("scoped"), target: sourceRef("move-destination") }),
    call("beta", "search", { path: at("edit.txt"), query: "beta" }),
    call("insert", "insert", {
      path: at("edit.txt"),
      anchor: ref("beta"),
      text: "inserted\n",
      before: true,
    }),
    call("replace-beta", "search", { path: at("edit.txt"), query: "beta" }),
    call("replace", "replace", {
      path: at("edit.txt"),
      from: ref("replace-beta"),
      through: ref("replace-beta"),
      text: "BETA",
    }),
    call("gamma", "search", { path: at("edit.txt"), query: "gamma" }),
    call("delete", "delete", { path: composite([{ id: `$issued-uuid:${prefix}-gamma` }]) }),
    call("write", "write", { path: at("literal.json"), content: literal }),
    call("literal", "read", { path: at("literal.json") }),
    call("malformed", "read", { path: at("[broken") }),
    call("diff", "diff", {
      before: { path: at("target.txt"), offset: 1, limit: 1, views: composite([]) },
      after: { path: at("copy.txt"), offset: 1, limit: 1, views: composite([]) },
    }),
  ];
}

async function exercise(cwd: string, root: string, get: (file: string) => Promise<string>) {
  const direct: Call[] = [];
  const scripts: Call[] = [];
  for (const form of ["native", "encoded"] as const) {
    direct.push(...calls(`${root}/direct-${form}`, `direct-${form}`, form === "encoded"));
    const steps = calls(`${root}/script-${form}`, `script-${form}`, form === "encoded");
    scripts.push({
      id: `script-${form}`,
      name: "codemode",
      arguments: {
        code: `
const results = {};
function references(value) {
  if (typeof value === "string") return value.replace(/\\$script-uuid:([a-z][a-z-]*)/g, (_, id) => {
    if (!results[id]?.id) throw Error("Missing reference " + id);
    return results[id].id;
  });
  if (Array.isArray(value)) return value.map(references);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, references(item)]));
  return value;
}
for (const step of ${JSON.stringify(steps).replaceAll("$issued-uuid:", "$script-uuid:")}) {
  results[step.id] = await tools[step.name](references(step.arguments));
  if (results[step.id] === null && !step.id.endsWith("-delete")) throw Error("Failed " + step.id);
}
const lists = Object.fromEntries(["search", "files", "ast", "lsp"].map(name => {
  const value = results[${JSON.stringify(`script-${form}-`)} + name];
  return [name, name === "files" ? value : value.matches.map(match => match.path)];
}));
text(JSON.stringify({ literal: results[${JSON.stringify(`script-${form}-literal`)}].text, lists }));`,
      },
    });
  }
  const result = await new PiIntegrationTest({
    testName: `json-structured-arguments-${root.startsWith("ssh://") ? "ssh" : "local"}`,
    cwd,
    rawMode: false,
    isolateUserResources: true,
    artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
    ],
    tools: [
      "read",
      "search",
      "file_search",
      "ast_search",
      "lsp_search",
      "write",
      "insert",
      "replace",
      "delete",
      "copy",
      "move",
      "diff",
      "codemode",
    ],
    timeoutMs: 180000,
    conversation: [...direct, ...scripts]
      .map((call) =>
        assistantMessage([
          toolCall({ ...call, chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
        ]),
      )
      .concat([assistantMessage([text("Done.")])]),
  }).run("Use native and JSON-text structured arguments.");
  for (const call of [...direct, ...scripts])
    expect(
      getToolExecution(result, call.id).isError,
      `${call.id}: ${getToolResultText(result, call.id)}`,
    ).toBe(false);
  for (const form of ["native", "encoded"]) {
    const output = getToolResultText(result, `script-${form}`);
    expect(codemodeFailures(output)).toBe("");
    const payload = output.split("\n").find((line) => line.startsWith('{"literal":'));
    if (payload === undefined) throw Error("Missing scripted JSON result");
    const data = JSON.parse(payload) as { literal: string; lists: Record<string, string[]> };
    expect(data.literal).toBe(literal);
    for (const tool of ["search", "files", "ast"]) {
      const directOutput = getToolResultText(result, `direct-${form}-${tool}`);
      for (const file of ["a/main.ts", "b/use.ts"]) {
        expect(directOutput).toContain(file);
        expect(data.lists[tool]).toEqual(expect.arrayContaining([expect.stringContaining(file)]));
      }
      expect(directOutput).not.toContain("skip.ts");
      expect(data.lists[tool]?.some((file) => file.endsWith("/skip.ts"))).toBe(false);
    }
    expect(getToolResultText(result, `direct-${form}-lsp`)).toContain("main.ts");
    expect(data.lists.lsp).toEqual(expect.arrayContaining([expect.stringContaining("main.ts")]));
    for (const route of ["direct", "script"]) {
      const file = (name: string) => get(`${route}-${form}/${name}`);
      expect(await file("source.txt")).toBe("head\ntail\n");
      for (const name of ["target.txt", "copy.txt", "move.txt"])
        expect(await file(name)).toBe("left DATA right\n");
      expect(await file("edit.txt")).toBe("alpha\ninserted\nBETA\nomega\n");
      expect(await file("literal.json")).toBe(literal);
    }
  }
}

test("JSON-text source references survive streaming guards and parallel edit planning", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const name of ["direct.txt", "script.txt"])
      await writeFile(path.join(cwd, name), "keep\none\nmiddle\ntwo\nend\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: ["ide.lsp", "ide.lint", "ide.formatter"],
      }),
    );
    const result = await new PiIntegrationTest({
      testName: "json-structured-parallel",
      cwd,
      rawMode: false,
      isolateUserResources: true,
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
      ],
      tools: ["read", "replace", "codemode"],
      conversation: [
        assistantMessage([
          toolCall({
            id: "one",
            name: "read",
            arguments: { path: "direct.txt", offset: 2, limit: 1 },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "two",
            name: "read",
            arguments: { path: "direct.txt", offset: 4, limit: 1 },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "replace-one",
            name: "replace",
            arguments: { path: '{"id":"$issued-uuid:one"}', text: "ONE\n" },
          }),
          toolCall({
            id: "replace-two",
            name: "replace",
            arguments: { path: '{"id":"$issued-uuid:two"}', text: "TWO\n" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "script",
            name: "codemode",
            arguments: {
              code: `
const one = await tools.read({ path: "script.txt", offset: 2, limit: 1 });
const two = await tools.read({ path: "script.txt", offset: 4, limit: 1 });
await Promise.all([
  tools.replace({ path: JSON.stringify({ id: one.id }), text: "ONE\\n" }),
  tools.replace({ path: JSON.stringify({ id: two.id }), text: "TWO\\n" }),
]);
text((await tools.read({ path: "script.txt" })).text);`,
            },
          }),
        ]),
        assistantMessage([text("Done.")]),
      ],
    }).run("Apply independent edits using issued reference objects.");
    for (const id of ["replace-one", "replace-two", "script"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(codemodeFailures(getToolResultText(result, "script"))).toBe("");
    for (const name of ["direct.txt", "script.txt"])
      expect(await readFile(path.join(cwd, name), "utf8")).toBe("keep\nONE\nmiddle\nTWO\nend\n");
  });
}, 60000);
for (const transport of ["local", "ssh"] as const) {
  test(`JSON-text source objects, lists and view arrays compose with native selectors over ${transport}`, async () => {
    await withTempWorkspace(async (cwd) => {
      const binary =
        transport === "ssh"
          ? (process.env.PI_IDE_AST_GREP_BINARY ??
            (await promisify(execFile)("which", ["ast-grep"])).stdout.trim())
          : undefined;
      const fixture = binary
        ? await startSshFixture(
            { "ast-grep": binary },
            { PI_CODING_AGENT_DIR: "{workspace}/agent-home" },
          )
        : undefined;
      const backend = fixture
        ? new SshBackend({
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          })
        : undefined;
      const root = fixture ? `ssh://fixture${fixture.workspace}` : ".";
      try {
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
          JSON.stringify({
            noAnimations: true,
            noPostProcessing: true,
            disabled: ["ide.formatter", "ide.lint", "ide.debugger", "ide.diagnostics"],
          }),
        );
        if (backend)
          await writeFile(
            path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
            JSON.stringify({ targets: [backend.target] }),
          );
        for (const route of ["direct", "script"])
          for (const form of ["native", "encoded"]) {
            const all = {
              ...files,
              "tsconfig.json": JSON.stringify({
                compilerOptions: { strict: true, paths: { "#token": ["./a/main.ts"] } },
                include: ["a", "b"],
              }),
            };
            for (const [file, content] of Object.entries(all)) {
              const name = `${route}-${form}/${file}`;
              if (backend && fixture)
                await backend.write(`${fixture.workspace}/${name}`, Buffer.from(content), null);
              else {
                await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
                await writeFile(path.join(cwd, name), content);
              }
            }
          }
        await exercise(cwd, root, async (file) =>
          backend && fixture
            ? (await backend.read(`${fixture.workspace}/${file}`)).bytes.toString("utf8")
            : readFile(path.join(cwd, file), "utf8"),
        );
      } finally {
        await fixture?.stop();
      }
    });
  }, 240000);
}
