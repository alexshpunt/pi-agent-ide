import { expect, test } from "vitest";

import { formatDoctorReport } from "./run.js";

import { doctorNeedsWork } from "./run.js";

import type { DoctorRun } from "./run.js";

test("does not treat informational warnings as setup work", () => {
  const run: DoctorRun = {
    cwd: "/project",
    files: [],
    detectedLanguages: new Map(),
    candidates: [],
    suggestions: [],
    selections: [],
    actions: [],
    sections: [
      {
        title: "Project",
        pluginId: "doctor",
        findings: [{ status: "warn", message: "No project files found" }],
      },
    ],
  };

  expect(doctorNeedsWork(run)).toBe(false);
});

test("protects Windows config paths in the Markdown report", () => {
  const configPath = String.raw`C:\dev\cc-dev-rnd\.pi\pi-agent-ide\lsp-servers.json`;
  const run: DoctorRun = {
    cwd: String.raw`C:\dev\cc-dev-rnd`,
    files: [],
    detectedLanguages: new Map(),
    candidates: [],
    suggestions: [],

    selections: [],
    actions: [],
    sections: [
      {
        title: "LSP",
        pluginId: "lsp",
        findings: [{ status: "pass", message: "1 language server loaded", detail: configPath }],
      },
    ],
  };

  expect(formatDoctorReport(run)).toContain(`        \`${configPath}\``);
});
