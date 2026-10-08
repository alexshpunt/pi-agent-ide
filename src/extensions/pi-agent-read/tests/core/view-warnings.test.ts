import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { AgentContent } from "pi-agent-resource";
import { createReadTool } from "#src/core/tools/tool-read.js";
import { createReadResultRenderer } from "#src/core/tools/read/read-renderer.js";

initTheme("dark", false);
const theme = {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  underline: (text: string): string => text,
} as Theme;
const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;

function reader(content: AgentContent) {
  const read = createReadTool();
  read.registerContributions("fixture", {
    resolvers: [
      {
        resolver: {
          id: "memory",
          async tryResolve(source) {
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return content;
                },
              },
            };
          },
        },
      },
    ],
    views: [
      {
        view: "anchors",
        presenter: {
          id: "anchor",
          present(document) {
            return {
              ...document,
              lines: document.lines.map((line) => ({
                ...line,
                presentation: { prefix: "anchor|" },
              })),
            };
          },
        },
      },
    ],
  });
  return read;
}

test("unknown views explain recovery without entering source lines or hiding valid views", async () => {
  const read = reader([{ type: "text", text: "alpha\nbeta" }]);
  try {
    const result = await read.execute(
      { path: "memory:notes", views: ["anchors", "ghost:value=1"] },
      { cwd: process.cwd() },
    );
    expect(result.details.ignoredViews).toEqual(["ghost:value=1"]);
    expect(result.details.viewWarnings).toHaveLength(1);
    const warning = result.details.viewWarnings?.[0];
    expect(warning).toContain("ghost:value=1");
    expect(result.content).toEqual([
      { type: "text", text: `${warning}\nanchor|alpha\nanchor|beta` },
    ]);
    expect(result.details.lines?.map((line) => line.content)).toEqual(["alpha", "beta"]);
    const rendered = createReadResultRenderer({ kind: "source" })(
      result,
      { expanded: false, isPartial: false },
      theme,
      { isError: false, lastComponent: undefined } as never,
    )
      .render(52)
      .join("\n");
    if (warning === undefined) throw new Error("Missing warning");
    expect(rendered.replaceAll("│", " ").replace(/\s+/gu, " ")).toContain(warning);
    expect(rendered).toContain("anchor|alpha");
    expect(rendered).toContain("anchor|beta");
    const script = await read.execute(
      { path: "memory:notes", views: ["ghost"] },
      { cwd: process.cwd() },
      "script",
    );
    expect(script.script).toMatchObject({ kind: "text", content: "alpha\nbeta" });
  } finally {
    await read.dispose();
  }
});

test("unknown view warnings preserve all native blocks even when the image is first", async () => {
  for (const content of [
    [image],
    [{ type: "text", text: "Image caption" }, image],
  ] satisfies AgentContent[]) {
    const read = reader(content);
    try {
      const result = await read.execute(
        { path: "memory:image", views: ["ghost"] },
        { cwd: process.cwd() },
      );
      expect(result.details.ignoredViews).toEqual(["ghost"]);
      expect(result.details.viewWarnings).toHaveLength(1);
      expect(result.details.viewWarnings?.[0]).toContain("ghost");
      expect(result.content).toEqual([
        { type: "text", text: result.details.viewWarnings?.[0] },
        ...content,
      ]);
      expect(result.details.lines).toBeUndefined();
      expect(result.isError).not.toBe(true);
    } finally {
      await read.dispose();
    }
  }
});

test("native views handled before reading do not trigger a text-only warning", async () => {
  const read = createReadTool();
  read.registerContributions("capture", {
    views: [
      {
        view: "image",
        contentKind: "any",
        presenter: { id: "image", present: (document) => document },
      },
    ],
    handlers: [
      {
        stage: "pre-read",
        handler() {
          return {
            kind: "return",
            result: { content: [image], details: { source: "capture:window" } },
          };
        },
      },
    ],
  });
  try {
    const valid = await read.execute(
      { path: "capture:window", views: ["image:scale=0.5"] },
      { cwd: process.cwd() },
    );
    expect(valid.content).toEqual([image]);
    expect(valid.details.viewWarnings).toBeUndefined();
    const unknown = await read.execute(
      { path: "capture:window", views: ["ghost"] },
      { cwd: process.cwd() },
    );
    expect(unknown.details.ignoredViews).toEqual(["ghost"]);
    expect(unknown.details.viewWarnings).toHaveLength(1);
    expect(unknown.details.viewWarnings?.[0]).toContain("ghost");
    expect(unknown.content).toEqual([
      { type: "text", text: unknown.details.viewWarnings?.[0] },
      image,
    ]);
  } finally {
    await read.dispose();
  }
});
test("a text view on native content explains why it did not apply", async () => {
  const read = reader([image]);
  try {
    const result = await read.execute(
      { path: "memory:image", views: ["anchors"] },
      { cwd: process.cwd() },
    );
    expect(result.details.viewWarnings).toHaveLength(1);
    expect(result.details.viewWarnings?.[0]).toContain("anchors");
    expect(result.content).toEqual([
      { type: "text", text: result.details.viewWarnings?.[0] },
      image,
    ]);
    expect(result.details.lines).toBeUndefined();
    expect(result.isError).not.toBe(true);
  } finally {
    await read.dispose();
  }
});
