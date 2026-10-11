import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { afterAll, afterEach, expect, test } from "vitest";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { TipStateStore } from "#src/tips/persistence.js";
import { createSetupHintProvider } from "#src/tips/setup-hint.js";

const restoreRuntime = forceStandaloneIntegrationFile();
afterAll(restoreRuntime);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const extension = process.env.PI_AGENT_IDE_TEST_EXTENSION ?? path.resolve("src/pi-agent-ide.ts");
const skill = path.resolve("skills/configure-agent-ide");
const setupTip = createSetupHintProvider(() => true).getTip({
  cwd: "/project",
  mode: "tui",
  hasUI: true,
  reason: "startup",
});
const setupIdentity = JSON.stringify(["agent-setup", "agent-setup-v1"]);

async function fixture() {
  const artifacts = testArtifactsDir(import.meta.filename);
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "setup-hint-"));
  roots.push(root);
  const agent = path.join(root, "agent");
  return { root, agent, state: new TipStateStore(path.join(agent, "pi-agent-ide", "tips.json")) };
}

async function run(
  root: string,
  agent: string,
  name: string,
  options: {
    skills?: boolean;
    transport?: "tui" | "rpc";
    disabled?: boolean;
    cols?: number;
    artifactName?: string;
  } = {},
) {
  const project = path.join(root, name);
  await mkdir(project, { recursive: true });
  const configPath = path.join(project, ".pi", "pi-agent-ide", "extensions.json");
  const config = JSON.stringify({
    disabled: options.disabled ? ["ide.tips"] : [],
    preferences: { "ui.codemode": "full" },
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, config);
  const result = await new PiIntegrationTest({
    testName: `setup-hint-${options.artifactName ?? name}`,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: project,
    extensions: [
      extension,
      ...(options.transport === "rpc"
        ? []
        : [path.resolve("tests/integration/fixtures/await-startup-tip.ts")]),
    ],
    skills: options.skills === false ? [] : [skill],
    tools: [],
    transport: options.transport ?? "tui",
    tuiSize: { cols: options.cols ?? 100, rows: 50 },
    environment: { PI_CODING_AGENT_DIR: agent },
    isolateUserResources: false,
    rawMode: false,
    conversation: [assistantMessage([text("Ready")])],
  }).run("Start the session and report when ready");
  expect(await readFile(configPath, "utf8")).toBe(config);
  expect(result.providerRequests).toHaveLength(1);
  return result;
}

test("shows one installation-wide hint and keeps its text out of agent context", async () => {
  const { root, agent, state } = await fixture();
  const tip = await setupTip;
  if (tip === undefined) throw new Error("Setup provider did not return a tip");
  const first = await run(root, agent, "first", { cols: 60 });
  expect(first.tuiRenderedOutput).toContain(`PI AGENT IDE · ${tip.title}`);
  expect(first.tuiRenderedOutput).toContain("/agent-ide-settings");
  expect(JSON.stringify(first.providerRequests)).not.toContain(tip.title);
  expect(JSON.stringify(first.messages)).not.toContain(tip.body);
  expect(await state.shownFor()).toEqual(new Set([setupIdentity]));

  const repeated = await run(root, agent, "first", { artifactName: "repeated" });
  const otherProject = await run(root, agent, "other-project");
  expect(repeated.tuiRenderedOutput).not.toContain(tip.title);
  expect(otherProject.tuiRenderedOutput).not.toContain(tip.title);
  expect(await state.shownFor()).toEqual(new Set([setupIdentity]));
});

test("does not consume the setup hint in ineligible sessions", async () => {
  const { root, agent, state } = await fixture();
  const tip = await setupTip;
  if (tip === undefined) throw new Error("Setup provider did not return a tip");
  for (const [name, options] of [
    ["without-skill", { skills: false }],
    ["tips-disabled", { disabled: true }],
    ["headless", { transport: "rpc" }],
  ] as const) {
    const result = await run(root, agent, name, options);
    expect(result.tuiRenderedOutput).not.toContain(tip.title);
    expect(await state.shownFor()).toEqual(new Set());
  }
  const eligible = await run(root, agent, "eligible-after-skips");
  expect(eligible.tuiRenderedOutput).toContain(tip.title);
  expect(await state.shownFor()).toEqual(new Set([setupIdentity]));
});
