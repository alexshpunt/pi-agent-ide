import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { piRuntime } from "#capabilities/inventory.ts";
import { isMountedPiPath } from "#capabilities/sandbox.ts";
import { sourceIdentity } from "#capabilities/source-identity.ts";
import { accountStopReason } from "#capabilities/run-policy.ts";
import { schedule } from "#capabilities/scheduler.ts";
import { variants } from "./fixtures.ts";
import {
  DEFAULT_MODELS,
  harnesses,
  ignoredPaths,
  passed,
  renderReport,
  runJob,
  sandboxExecutor,
  type Job,
  type Row,
} from "./runner.ts";
import { selfCheck } from "./self-check.ts";

const HELP = `Byte-exact edit benchmark (Linux/WSL, Bubblewrap)

Free:  --list | --check
Paid:  --run --auth-dir DIR [--models M[,M]] [--thinking LEVEL] [--harnesses stock,ide]
       [--variants mid,end,crlf,bom] [--runs N] [--concurrency N] [--timeout SECONDS]
       [--results NEW_DIR] [--pi COMMAND]

Defaults: --models ${DEFAULT_MODELS.join(",")} --thinking low --runs 2 --concurrency 4 --timeout 300.
No model calls occur without --run.`;

const repository = findRepositoryRoot(import.meta.url);
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    help: { type: "boolean" },
    list: { type: "boolean" },
    check: { type: "boolean" },
    run: { type: "boolean" },
    models: { type: "string", default: DEFAULT_MODELS.join(",") },
    thinking: { type: "string", default: "low" },
    harnesses: { type: "string", default: harnesses.map((harness) => harness.id).join(",") },
    variants: { type: "string", default: variants.map((variant) => variant.id).join(",") },
    runs: { type: "string", default: "2" },
    concurrency: { type: "string", default: "4" },
    timeout: { type: "string", default: "300" },
    results: { type: "string" },
    "auth-dir": { type: "string" },
    pi: { type: "string", default: "pi" },
  },
});

function select<T extends { id: string }>(all: readonly T[], list: string, kind: string): T[] {
  const ids = list.split(",").filter(Boolean);
  const selected = ids.map((id) => all.find((entry) => entry.id === id));
  if (!ids.length || selected.some((entry) => !entry))
    throw Error(`Unknown or empty ${kind} selection: ${list}`);
  return selected as T[];
}

function positive(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw Error(`${name} must be a positive integer`);
  return number;
}

async function main(): Promise<void> {
  if (values.help || !(values.list || values.check || values.run)) {
    console.log(HELP);
    return;
  }
  if (values.list) {
    for (const variant of variants) console.log(`${variant.id}: ${variant.summary}`);
    for (const harness of harnesses) console.log(`${harness.id}: ${harness.tools.join(", ")}`);
    return;
  }
  if (values.check) {
    await selfCheck(path.join(repository, ".tmp"));
    console.log("Byte-exact edit self-check passed: fixture, grader and runner. No model calls.");
    return;
  }
  const models = values.models.split(",").filter(Boolean);
  if (!models.length || models.some((model) => !/^[^/\s]+\/\S+$/u.test(model)))
    throw Error("--models takes provider/model ids");
  const selectedHarnesses = select(harnesses, values.harnesses, "harness");
  const selectedVariants = select(variants, values.variants, "variant");
  const runs = positive(values.runs, "--runs");
  const concurrency = positive(values.concurrency, "--concurrency");
  const timeoutMs = positive(values.timeout, "--timeout") * 1000;
  const authDir = values["auth-dir"];
  if (!authDir) throw Error("--run requires --auth-dir with a private Pi auth.json snapshot");
  const runtime = await piRuntime(values.pi);
  if (!isMountedPiPath(runtime.cli))
    throw Error(
      "Paid runs need an installed Pi inside the read-only system toolchain mounts. Use --pi to select it.",
    );

  const source = await sourceIdentity(repository);
  const results = path.resolve(
    values.results ??
      path.join(
        repository,
        ".tmp/byte-exact-edit-results",
        new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8),
      ),
  );
  await mkdir(path.dirname(results), { recursive: true });
  await mkdir(results);
  await mkdir(path.join(repository, ".tmp"), { recursive: true });
  const parent = await mkdtemp(path.join(repository, ".tmp/byte-exact-run-"));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let rows: Row[] = [];
  let stoppedFor: string | undefined;
  try {
    const manifest = {
      ...source,
      piVersion: runtime.version,
      models,
      thinking: values.thinking,
      harnesses: selectedHarnesses.map((harness) => ({ id: harness.id, tools: harness.tools })),
      variants: selectedVariants.map((variant) => variant.id),
      runs,
      concurrency,
      timeoutMs,
      started: new Date().toISOString(),
    };
    await writeFile(path.join(results, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const jobs: Job[] = models.flatMap((model) =>
      selectedHarnesses.flatMap((harness) =>
        selectedVariants.flatMap((variant) =>
          Array.from({ length: runs }, (_, index) => ({
            model,
            thinking: values.thinking,
            harness,
            variant,
            run: index + 1,
          })),
        ),
      ),
    );
    const executor = sandboxExecutor({
      source: repository,
      hidden: ignoredPaths(
        execFileSync(
          "git",
          ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
          { cwd: repository, encoding: "utf8" },
        ),
      ),
      cli: runtime.cli,
      authDir,
      timeoutMs,
    });
    console.log(`Running ${jobs.length} runs, ${concurrency} at a time. Raw output: ${results}`);
    const outcome = await schedule(jobs, concurrency, abort, {
      resource: () => undefined,
      stopReason: accountStopReason,
      run: async (job, signal) => {
        const row = await runJob(job, { parent, results, executor, signal });
        console.log(
          `${row.grade.result}: ${row.id}${row.status === "ok" ? "" : ` (${row.status})`}`,
        );
        return row;
      },
      publish: async (completed) => {
        rows = completed;
        await writeFile(path.join(results, "rows.json"), JSON.stringify(rows, null, 2) + "\n");
      },
    });
    stoppedFor = outcome.stoppedFor;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await rm(parent, { recursive: true, force: true });
  }
  const report = renderReport(rows, selectedVariants);
  await writeFile(path.join(results, "report.md"), report);
  console.log("\n" + report);
  if (stoppedFor) console.log(`Stopped early: ${stoppedFor}`);
  if ((await sourceIdentity(repository)).sourceDigest !== source.sourceDigest) {
    console.log("The checkout changed during the run: results may mix two versions of the source.");
    process.exitCode = 1;
  }
  console.log(`Results: ${results}`);
  if (abort.signal.aborted || !rows.every(passed)) process.exitCode = 1;
}

await main();
