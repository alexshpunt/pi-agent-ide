import { describe, expect, test } from "vitest";

import { createDoctorTipProvider, registerDoctorTipProvider } from "./tip-provider.js";

import type { DoctorSetupRun } from "./run.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const context = {
  cwd: "/project",
  mode: "tui" as const,
  hasUI: true,
  reason: "startup" as const,
};

describe("doctor tip provider registration", () => {
  test("uses the extension API before registration returns", () => {
    let announcements = 0;
    const pi = {} as ExtensionAPI;
    Object.assign(pi, {
      events: {
        on: () => () => {},
        emit: (_event: string, request: unknown) => {
          announcements += 1;
          (request as { accept(value: Promise<void>): void }).accept(Promise.resolve());
        },
      },
      on: () => {},
    });

    registerDoctorTipProvider(pi, async () => setup());

    expect(announcements).toBe(1);
  });
});

describe("doctor startup tip provider", () => {
  test("stays quiet when setup has no actionable items", async () => {
    const provider = createDoctorTipProvider(async () => setup());

    await expect(provider.getTip(context)).resolves.toBeUndefined();
  });

  test("names concrete setup problems", async () => {
    const provider = createDoctorTipProvider(async () =>
      setup({
        actions: [
          {
            pluginId: "lint",
            id: "linter-eslint-unavailable",
            message: "Configured linter eslint is unavailable",
          },
        ],
      }),
    );

    const tip = await provider.getTip(context);
    expect(tip?.id).toMatch(/^doctor-setup-[a-f0-9]{12}$/u);
    expect(tip?.title).toBe("Project setup needs attention");
    expect(tip?.body).toBe("• Configured linter eslint is unavailable\nRun /pi-agent-ide-doctor");
  });

  test("names a detected tool opportunity", async () => {
    const provider = createDoctorTipProvider(async () =>
      setup({
        detectedLanguages: new Map([["typescript", ["/project/source.ts"]]]),
        suggestions: [
          {
            pluginId: "formatter",
            score: 10,
            evidence: ["project config: biome.json", "executable: biome"],
            executable: "biome",
            recipe: {
              id: "biome",
              name: "biome",
              kind: "formatter",
              languages: ["typescript"],
              executables: ["biome"],
              documentation: "https://biomejs.dev/",
              formatter: {
                extensions: [".ts"],
                run: { command: ["biome", "format", "--write", "{file}"] },
                output: "in-place",
              },
            },
          },
        ],
      }),
    );

    const tip = await provider.getTip(context);
    expect(tip?.body).toContain("Use biome for typescript formatting");
  });

  test("changes identity when the actionable setup state changes", async () => {
    const first = createDoctorTipProvider(async () =>
      setup({
        actions: [{ pluginId: "lint", id: "eslint", message: "ESLint needs attention" }],
      }),
    );
    const second = createDoctorTipProvider(async () =>
      setup({
        actions: [{ pluginId: "lsp", id: "typescript", message: "TypeScript LSP needs attention" }],
      }),
    );

    const firstTip = await first.getTip(context);
    const secondTip = await second.getTip(context);
    expect(firstTip?.id).not.toBe(secondTip?.id);
  });
});

function setup(overrides: Partial<DoctorSetupRun> = {}): DoctorSetupRun {
  return {
    cwd: context.cwd,
    files: [],
    detectedLanguages: new Map(),
    candidates: [],
    suggestions: [],
    selections: [],
    actions: [],
    ...overrides,
  };
}
