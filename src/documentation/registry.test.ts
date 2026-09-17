import { describe, expect, test } from "vitest";

import type { AgentDocumentation } from "#src/api/documentation.js";
import { AgentDocumentationRegistry } from "#src/documentation/registry.js";

const document = (id: string, overrides: Partial<AgentDocumentation> = {}): AgentDocumentation => ({
  id,
  description: `${id} description`,
  markdown: `# ${id}`,
  triggers: [{ tool: "read" }],
  ...overrides,
});

describe("AgentDocumentationRegistry", () => {
  test("validates IDs, content, triggers, and duplicates atomically", () => {
    const registry = new AgentDocumentationRegistry();
    registry.register([document("valid")]);

    expect(() => registry.register([document("Bad ID")])).toThrow("Invalid documentation ID");
    expect(() => registry.register([document("empty", { markdown: "" })])).toThrow("Markdown");
    expect(() => registry.register([document("no-tools", { triggers: [] })])).toThrow("triggers");
    expect(() => registry.register([document("valid")])).toThrow("already registered");
    expect(() => registry.register([document("batch"), document("batch")])).toThrow(
      "already registered",
    );
    expect(registry.list().map(({ id }) => id)).toEqual(["valid"]);
  });

  test("lists deterministically and filters by tool, resource, and view prefix", () => {
    const registry = new AgentDocumentationRegistry();
    registry.register([
      document("vision", { triggers: [{ tool: "read", resourcePrefixes: ["window:"] }] }),
      document("json-reading", { triggers: [{ tool: "read", viewPrefixes: ["jq:"] }] }),
      document("general"),
      document("editing", { triggers: [{ tool: "replace" }] }),
    ]);

    expect(registry.list().map(({ id }) => id)).toEqual([
      "editing",
      "general",
      "json-reading",
      "vision",
    ]);
    expect(registry.matching("read", { path: "file.ts" }).map(({ id }) => id)).toEqual(["general"]);
    expect(
      registry
        .matching("read", { path: "file.json", views: ["jq:.items | length"] })
        .map(({ id }) => id),
    ).toEqual(["general", "json-reading"]);
    expect(registry.matching("read", { path: "window:42" }).map(({ id }) => id)).toEqual([
      "general",
      "vision",
    ]);
    expect(registry.matching("replace", { path: "file.ts" }).map(({ id }) => id)).toEqual([
      "editing",
    ]);
    expect(registry.matching("read", { path: "docs:vision" })).toEqual([]);
  });
});
