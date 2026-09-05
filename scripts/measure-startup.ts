import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

/** Measures actual Pi RPC readiness in fresh processes with isolated user resources. */
async function measure(
  entry: string | undefined,
  directory: string,
  workspace: string,
): Promise<number> {
  await mkdir(directory, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  const child = spawn(
    process.env.PI_COMMAND ?? "pi",
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      ...(entry === undefined ? [] : ["-e", entry]),
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: path.join(workspace, "agent"),
        PI_TIMING: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let duration: number | undefined;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const line of stdout.split("\n")) {
      let value: { id?: string; success?: boolean };
      try {
        value = JSON.parse(line) as typeof value;
      } catch {
        continue;
      }
      if (value.id === "startup-probe" && value.success === true && duration === undefined) {
        duration = performance.now() - started;
        child.kill("SIGTERM");
      }
    }
  });
  child.stdin.write(`${JSON.stringify({ id: "startup-probe", type: "get_state" })}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
  } finally {
    clearTimeout(timeout);
  }
  await writeFile(path.join(directory, "startup.log"), `${stderr}\n${stdout}`);
  if (duration === undefined || /Failed to load extension/.test(stderr)) {
    throw new Error(`Pi did not load cleanly: ${stderr}`);
  }
  return duration;
}

const [baseline, candidate, destination] = process.argv.slice(2);
if (baseline === undefined || candidate === undefined || destination === undefined) {
  throw new Error(
    "Usage: measure-startup.ts <baseline-entry> <candidate-entry> <artifact-directory>",
  );
}
const directory = path.resolve(destination);
const variants = {
  empty: undefined,
  baseline: path.resolve(baseline),
  candidate: path.resolve(candidate),
};
const samples: { variant: string; round: number; ms: number }[] = [];
for (let round = -1; round < 5; round++) {
  for (const [variant, entry] of Object.entries(variants)) {
    const ms = await measure(
      entry,
      path.join(directory, `${variant}-${round}`),
      path.join(directory, "workspace"),
    );
    samples.push({ variant, round, ms });
  }
}
const summary = Object.fromEntries(
  Object.keys(variants).map((variant) => {
    const values = samples
      .filter((row) => row.variant === variant && row.round >= 0)
      .map((row) => row.ms)
      .sort((a, b) => a - b);
    return [variant, { min: values[0], median: values[2], max: values[4] }];
  }),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ node: process.version, samples, summary }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
