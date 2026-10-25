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

// Point at a copied public-import fixture to check the packed SDK from a clean consumer.
const providerFixture = path.resolve(
  process.env.PI_STANDALONE_CONSUMER_EXTENSION ??
    "tests/integration/fixtures/standalone-resource-provider.ts",
);

// Pattern: the native-host and external-plugin examples, with a real external URI provider.
// Contract: shared kernels retain scope in Codemode without exposing host filesystem operations.
test("standalone resource tools preserve selections and refuse local fallbacks", async () => {
  const root = path.resolve(".tmp/standalone-resource-host");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  try {
    await writeFile(path.join(cwd, "resource.txt"), "alpha\nomega\n");
    await writeFile(path.join(cwd, "local.txt"), "local sentinel\n");
    const calls = [
      { id: "duplicate", name: "duplicate_status", arguments: {} },
      { id: "discover", name: "tool_search", arguments: { query: "demo", limit: 20 } },
      { id: "guide", name: "demo_read", arguments: { path: "docs:demo" } },
      {
        id: "script",
        name: "codemode",
        arguments: {
          code: [
            'if (JSON.stringify(await describeTool("demo_read")).includes("demo_read-resources")) throw new Error("Namespacing corrupted a guide ID");',
            'const source = await tools.demo_read({path: "memory://demo/note", offset: 1, limit: 1});',
            'const selected = await tools.demo_search({path: source, query: "regex:\\\\S+"});',
            'text(await tools.demo_replace({path: selected.result, text: "changed"}));',
          ].join("\n"),
        },
      },
      { id: "verify", name: "demo_read", arguments: { path: "memory://demo/note" } },
      {
        id: "direct-edit",
        name: "demo_replace",
        arguments: { path: "memory://demo/note", start: "changed", text: "direct" },
      },
      { id: "direct-verify", name: "demo_read", arguments: { path: "memory://demo/note" } },
      { id: "local-read", name: "demo_read", arguments: { path: "local.txt" } },
      {
        id: "raw-local",
        name: "demo_read",
        arguments: { path: "raw:" + path.join(cwd, "local.txt") },
      },
      { id: "local-write", name: "demo_write", arguments: { path: "local.txt", content: "wrong" } },
      {
        id: "local-copy",
        name: "demo_copy",
        arguments: { path: "memory://demo/note", target: "local.txt" },
      },
      {
        id: "image-write",
        name: "demo_write",
        arguments: {
          path: "memory://demo/note",
          content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        },
      },
    ];
    const result = await new PiIntegrationTest({
      testName: "standalone-resource-host-bounds",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        providerFixture,
        path.resolve("tests/integration/fixtures/standalone-duplicate-provider.ts"),
        "builtin:codemode",
        "builtin:tool-search",
      ],
      tools: ["tool_search", "codemode", "duplicate_status"],
      timeoutMs: 60_000,
      conversation: [
        ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run(
      "Use only the demo provider's resources; preserve its second line and refuse local fallbacks.",
    );
    for (const id of [
      "duplicate",
      "discover",
      "guide",
      "script",
      "verify",
      "direct-edit",
      "direct-verify",
    ])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    for (const id of ["local-read", "raw-local", "local-write", "local-copy", "image-write"])
      expect(getToolExecution(result, id).isError, id).toBe(true);
    expect(getToolResultText(result, "guide")).toContain("Demo resources");
    expect(getToolResultText(result, "verify")).toContain("changed\nomega");
    expect(getToolResultText(result, "direct-verify")).toContain("direct\nomega");
    expect(result.tuiRenderedOutput).toContain("+0 ~1 -0");
    expect(result.tuiRenderedOutput).toMatch(/demo_replace memory:\/\/demo\/note[\s\S]*~ direct/u);
    expect(await readFile(path.join(cwd, "resource.txt"), "utf8")).toBe("direct\nomega\n");
    expect(await readFile(path.join(cwd, "local.txt"), "utf8")).toBe("local sentinel\n");
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);

// Real extension load order and event composition, not a mock ExtensionAPI.
test.each(["alone", "before", "after"] as const)(
  "isolates sibling hosts and selections with IDE %s",
  async (order) => {
    const root = path.resolve(".tmp/standalone-resource-host");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "coexist-"));
    try {
      await writeFile(path.join(cwd, "resource.txt"), "alpha\nomega\n");
      await writeFile(path.join(cwd, "other.txt"), "sibling\n");
      await writeFile(path.join(cwd, "local.txt"), "local sentinel\n");
      const provider = providerFixture;
      const ide = path.resolve("src/pi-agent-ide.ts");
      const extensions =
        order === "alone" ? [provider] : order === "before" ? [ide, provider] : [provider, ide];
      const code = [
        'async function refused(action) { let failed = false; try { await action(); } catch { failed = true; } if (!failed) throw new Error("Expected boundary refusal"); }',
        'const original = await tools.demo_read({path: "memory://demo/note", offset: 1, limit: 1});',
        'const sibling = await tools.other_read({path: "memory://other/note"});',
        'await refused(() => tools.other_replace({path: original, text: "wrong"}));',
        'await refused(() => tools.demo_replace({path: sibling, text: "wrong"}));',
        'await refused(() => tools.demo_read({path: "memory://other/note"}));',
        'await refused(() => tools.demo_read({path: "memory://demo/missing"}));',
        'await refused(() => tools.demo_move({path: original, target: "local.txt"}));',
        'await tools.demo_write({path: "memory://demo/note", content: "temporary\\nomega\\n"});',
        'await tools.demo_write({path: "memory://demo/note", content: "alpha\\nomega\\n"});',
        'await refused(() => tools.demo_replace({path: original, text: "resurrected"}));',
        'const fresh = await tools.demo_read({path: "memory://demo/note", offset: 1, limit: 1});',
        'const found = await tools.demo_search({path: fresh, query: "alpha"});',
        'if (!found.hasMatches) throw new Error("Owned Search lost its match");',
        'text(await tools.demo_replace({path: found.result, text: "changed"}));',
        'await refused(() => tools.demo_replace({path: original, text: "stale"}));',
        ...(order === "alone"
          ? []
          : [
              'const local = await tools.read({path: "local.txt"});',
              'await refused(() => tools.demo_replace({path: local, text: "wrong"}));',
              'await refused(() => tools.replace({path: sibling, text: "wrong"}));',
            ]),
        'text("Isolation checks passed");',
      ].join("\n");
      const calls = [
        { id: "discover", name: "tool_search", arguments: { query: "demo other", limit: 30 } },
        { id: "exercise", name: "codemode", arguments: { code } },
        { id: "dispose", name: "cancel_demo", arguments: {} },
        { id: "closed", name: "demo_read", arguments: { path: "memory://demo/note" } },
        { id: "sibling", name: "other_read", arguments: { path: "memory://other/note" } },
        ...(order === "alone"
          ? []
          : [{ id: "local", name: "read", arguments: { path: "local.txt" } }]),
      ];
      const result = await new PiIntegrationTest({
        testName: `standalone-coexist-${order}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [...extensions, "builtin:codemode", "builtin:tool-search"],
        tools: [
          "tool_search",
          "codemode",
          "cancel_demo",
          ...(order === "alone" ? [] : ["read", "replace"]),
        ],
        timeoutMs: 60_000,
        conversation: [
          ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Check owned Search edits, sibling isolation, stale references and independent disposal.",
      );
      for (const id of [
        "discover",
        "exercise",
        "dispose",
        "sibling",
        ...(order === "alone" ? [] : ["local"]),
      ])
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      expect(getToolResultText(result, "exercise")).toContain("Isolation checks passed");
      expect(getToolExecution(result, "closed").isError).toBe(true);
      expect(await readFile(path.join(cwd, "resource.txt"), "utf8")).toBe("changed\nomega\n");
      expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("sibling\n");
      expect(await readFile(path.join(cwd, "local.txt"), "utf8")).toBe("local sentinel\n");
      expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);
