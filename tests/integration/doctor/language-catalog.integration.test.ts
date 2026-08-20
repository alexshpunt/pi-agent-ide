import { requiredValue } from "../../../src/utils/required-value.js";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import { projectIdeConfigPath } from "pi-agent-ide/api/tool-config";

import { writeSuggestedConfigs } from "#src/doctor/config-writer.js";
import { DoctorCore } from "#src/doctor/core.js";
import { runDoctor } from "#src/doctor/run.js";
import { astDoctorPlugin } from "#src/plugins/pi-agent-ide-ast/src/doctor-plugin.js";
import { formatterDoctorPlugin } from "#src/plugins/pi-agent-ide-formatter/src/doctor-plugin.js";
import { FORMATTER_RECIPES } from "#src/plugins/pi-agent-ide-formatter/src/catalog.js";
import { LANGUAGES } from "#src/plugins/pi-agent-ide-languages/src/languages.js";
import { lintDoctorPlugin } from "#src/plugins/pi-agent-ide-lint/src/doctor-plugin.js";
import { LINTER_RECIPES } from "#src/plugins/pi-agent-ide-lint/src/catalog.js";
import { lspDoctorPlugin } from "#src/plugins/pi-agent-ide-lsp/src/doctor-plugin.js";
import { LSP_RECIPES } from "#src/plugins/pi-agent-ide-lsp/src/catalog.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

const temporaryRoot = path.resolve(".agents", "tmp", "doctor-language-integration");
const allRecipes = [...FORMATTER_RECIPES, ...LINTER_RECIPES, ...LSP_RECIPES];
const sampleNames: Record<string, string> = {
  c: "main.c",
  cpp: "main.cpp",
  csharp: "Program.cs",
  go: "main.go",
  java: "Main.java",
  kotlin: "Main.kt",
  javascript: "index.js",
  typescript: "index.ts",
  python: "main.py",
  rust: "main.rs",
  ruby: "main.rb",
  php: "index.php",
  swift: "main.swift",
  lua: "main.lua",
  shell: "main.sh",
  html: "index.html",
  css: "style.css",
  json: "data.json",
  yaml: "data.yaml",
  toml: "data.toml",
  xml: "data.xml",
  markdown: "README.md",
  sql: "query.sql",
  dockerfile: "Dockerfile",
  terraform: "main.tf",
  cmake: "CMakeLists.txt",
};

beforeAll(async () => {
  await mkdir(temporaryRoot, { recursive: true });
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("doctor language mini-projects", () => {
  for (const language of LANGUAGES) {
    it(`${language.name} contributions configure and probe in isolation`, async () => {
      const cwd = await mkdtemp(path.join(temporaryRoot, `${language.id}-`));
      const bin = path.join(cwd, "bin");
      await mkdir(bin);
      await writeFile(path.join(cwd, sampleNames[language.id]), sampleSource(language.id), "utf8");
      const relevant = allRecipes.filter((recipe) => recipe.languages.includes(language.id));
      expect(new Set(relevant.map((recipe) => recipe.kind))).toEqual(
        new Set(["formatter", "linter", "lsp"]),
      );
      const chosen = (["formatter", "linter", "lsp"] as const).map((kind) =>
        requiredValue(relevant.find((recipe) => recipe.kind === kind)),
      );
      await createEvidence(cwd, chosen);
      await createFakeExecutables(bin, chosen);

      const core = new DoctorCore();
      await core.registerPlugin(languagePlugin(language.id));
      await core.registerPlugin(formatterDoctorPlugin);
      await core.registerPlugin(lintDoctorPlugin);
      await core.registerPlugin(lspDoctorPlugin);
      await core.registerPlugin(astDoctorPlugin);
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
      const first = await runDoctor(core.snapshot(), cwd, env);
      expect(first.detectedLanguages.has(language.id)).toBe(true);
      expect(new Set(first.suggestions.map((candidate) => candidate.recipe.kind))).toEqual(
        new Set(["formatter", "linter", "lsp"]),
      );

      await writeSuggestedConfigs(cwd, first.suggestions);
      const second = await runDoctor(core.snapshot(), cwd, env);
      expect(
        second.sections
          .flatMap((section) => section.findings)
          .filter((finding) => finding.status === "fail"),
      ).toEqual([]);
      await expectConfigEntries(cwd);
    }, 30_000);
  }
});

function languagePlugin(id: string): DoctorPlugin {
  const language = requiredValue(LANGUAGES.find((candidate) => candidate.id === id));
  return {
    protocol: DOCTOR_PROTOCOL,
    apiVersion: DOCTOR_API_VERSION,
    id: `language-${id}`,
    setup(api): void {
      api.addLanguage(language);
    },
  };
}

async function createEvidence(cwd: string, recipes: typeof allRecipes): Promise<void> {
  for (const recipe of recipes) {
    const marker = recipe.configFiles?.[0];
    if (marker === undefined) continue;
    const file = path.join(cwd, marker);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      marker.endsWith(".json") || marker === "package.json" ? "{}\n" : "# fixture\n",
      "utf8",
    );
  }
}

async function createFakeExecutables(bin: string, recipes: typeof allRecipes): Promise<void> {
  const lspNames = new Set(
    recipes.filter((recipe) => recipe.kind === "lsp").flatMap((recipe) => recipe.executables),
  );
  const formatterNames = new Set(
    recipes.filter((recipe) => recipe.kind === "formatter").flatMap((recipe) => recipe.executables),
  );
  const script = fakeToolScript([...lspNames], [...formatterNames]);
  const executableNames = new Set([...recipes.flatMap((recipe) => recipe.executables), "ast-grep"]);
  for (const name of executableNames) {
    const file = path.join(bin, name);
    await writeFile(file, script, "utf8");
    await chmod(file, 0o755);
  }
}

function fakeToolScript(lspNames: readonly string[], formatterNames: readonly string[]): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const lsp = ${JSON.stringify(lspNames)}.includes(name) && !(name === "taplo" && args[0] !== "lsp");
if (lsp) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
  function drain() {
    while (true) {
      const split = buffer.indexOf("\\r\\n\\r\\n"); if (split < 0) return;
      const header = buffer.subarray(0, split).toString(); const match = /Content-Length: (\\d+)/i.exec(header); if (!match) return;
      const length = Number(match[1]); if (buffer.length < split + 4 + length) return;
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()); buffer = buffer.subarray(split + 4 + length);
      if (message.id !== undefined) respond(message.id, message.method === "initialize" ? { capabilities: {} } : null);
      if (message.method === "exit") process.exit(0);
    }
  }
  function respond(id, result) { const body = JSON.stringify({ jsonrpc: "2.0", id, result }); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); }
} else {
  const target = [...args].reverse().find(value => existsSync(value));
  const format = ${JSON.stringify(
    formatterNames,
  )}.includes(name) && (args.includes("format") || args.includes("fmt") || args.includes("-w") || args.includes("-i") || args.includes("--write") || args.includes("--replace") || args.includes("--overwrite") || args.includes("-F") || args.includes("-A") || !args.some(value => value.includes("lint") || value.includes("check")));
  if (format && target) appendFileSync(target, "\\n");
  else if (!format) process.stdout.write((target || "fixture") + ":1:1: warning: fixture diagnostic [fixture]\\n");
}
`;
}

function sampleSource(language: string): string {
  const sources: Record<string, string> = {
    c: "int main(void) { return 0; }\n",
    cpp: "int main() { return 0; }\n",
    javascript: "export const value = 1;\n",
    typescript: "export const value: number = 1;\n",
    python: "value = 1\n",
    rust: "fn main() {}\n",
    json: "{}\n",
    yaml: "value: 1\n",
    toml: "value = 1\n",
    xml: "<root/>\n",
    html: "<main></main>\n",
    css: "main { color: black; }\n",
    markdown: "# Fixture\n",
    dockerfile: "FROM scratch\n",
    cmake: "cmake_minimum_required(VERSION 3.20)\n",
  };
  return sources[language] ?? "fixture\n";
}

async function expectConfigEntries(cwd: string): Promise<void> {
  for (const [name, key] of [
    ["formatters", "formatters"],
    ["linters", "linters"],
    ["lsp-servers", "servers"],
  ] as const) {
    const value = JSON.parse(await readFile(projectIdeConfigPath(cwd, name), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(value[key])).not.toHaveLength(0);
  }
}
