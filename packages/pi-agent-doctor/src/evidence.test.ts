import { expect, test } from "vitest";
import { inspectRecipeEvidence } from "./evidence.js";
import type { ToolRecipe } from "./catalog.js";

const recipe: ToolRecipe = {
  id: "owned",
  name: "Owned server",
  kind: "lsp",
  languages: ["typescript"],
  executables: ["owned-server"],
  documentation: "https://example.com/owned",
  configFiles: ["*.owned.json"],
  configSections: { "package.json": ["owned.settings"] },
  dependencies: ["owned-server"],
};

test("native recipe evidence uses only its configured project owner", async () => {
  const reads: string[] = [];
  const markers: string[] = [];
  const evidence = await inspectRecipeEvidence("ssh://fixture/workspace", [recipe], {
    readText: async (file) => {
      reads.push(file);
      return file === "package.json"
        ? JSON.stringify({ devDependencies: { "owned-server": "1" }, owned: { settings: {} } })
        : undefined;
    },
    hasMarker: async (marker) => {
      markers.push(marker);
      return marker === "*.owned.json";
    },
  });
  expect(evidence.get("owned")).toEqual({
    score: 10,
    config: "*.owned.json",
    dependency: "owned-server",
  });
  expect(reads).toEqual(["package.json"]);
  expect(markers).toEqual(["*.owned.json"]);
});

test("owner refusal is not converted into absent evidence or controller fallback", async () => {
  await expect(
    inspectRecipeEvidence("ssh://fixture/workspace", [recipe], {
      readText: async () => {
        throw Object.assign(new Error("Owner unavailable"), { code: "CONNECTION_LOST" });
      },
      hasMarker: async () => false,
    }),
  ).rejects.toMatchObject({ code: "CONNECTION_LOST" });
});

test("cancelled owned marker checks retain the invocation reason", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancel owned marker check");
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = inspectRecipeEvidence(
    "ssh://fixture/workspace",
    [recipe],
    {
      readText: async () => undefined,
      hasMarker: (_marker, signal) => {
        expect(signal).toBe(controller.signal);
        entered?.();
        return new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Owner marker cancelled")), {
            once: true,
          });
        });
      },
    },
    controller.signal,
  ).catch((error: unknown) => error);
  await started;
  controller.abort(reason);
  expect(await pending).toBe(reason);
});
