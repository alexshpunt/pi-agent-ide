import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BOM,
  FIXTURE_FILE,
  NBSP,
  NNBSP,
  SHY,
  WJ,
  ZWSP,
  editSpan,
  expectedText,
  fixtureText,
  variants,
} from "./fixtures.ts";
import { grade, specials } from "./grade.ts";
import {
  harnesses,
  ignoredPaths,
  piArguments,
  renderReport,
  runJob,
  variantFiles,
  type Executor,
  type Job,
  type Row,
} from "./runner.ts";

function checkFixture(): void {
  const text = fixtureText();
  assert.equal(text, fixtureText(), "the fixture is deterministic");
  assert.equal(text.split("\n").length, 75);
  assert.ok(text.startsWith(BOM));
  for (const character of [NBSP, NNBSP, ZWSP, WJ, SHY, "\t"]) assert.ok(text.includes(character));
  assert.ok(text.includes("\n\tfeature"), "a tab indent among space indents");
  assert.ok(/ {2,}\r?\n/u.test(text), "trailing spaces");
  assert.ok(/\t\r?\n/u.test(text), "a trailing tab");
  const crlf = text.split("\r\n").length - 1;
  const lines = text.split("\n").length - 1;
  assert.ok(crlf > lines / 5 && crlf < lines / 2, `CRLF on about a third of the lines (${crlf})`);
  assert.ok(!text.endsWith("\n"), "no final line break");
  for (const variant of variants) {
    const expected = expectedText(text, variant);
    const { start, end } = editSpan(text, variant.edit);
    assert.equal(
      expected,
      text.slice(0, start) + variant.edit.replacement + text.slice(end),
      `${variant.id}: expected = file[:start] + replacement + file[end:]`,
    );
    assert.notEqual(expected, text, `${variant.id} changes the file`);
    assert.deepEqual(
      specials(expected),
      specials(text),
      `${variant.id}: the intended edit keeps every special character`,
    );
    assert.ok(variant.intended(expected), `${variant.id}: expected shows the intended change`);
    assert.ok(!variant.intended(text), `${variant.id}: the original lacks the intended change`);
    assert.match(variant.prompt, /^[\x20-\x7e]+$/u, `${variant.id}: the prompt is plain ASCII`);
  }
  const at = (variant: string) => {
    const found = variants.find((entry) => entry.id === variant);
    assert.ok(found);
    return editSpan(text, found.edit);
  };
  assert.equal(at("end").end + ";".length, text.length, "the end variant edits the last line");
  assert.equal(at("bom").start, BOM.length, "the BOM variant edits right after the BOM");
  assert.equal(text.slice(at("crlf").end, at("crlf").end + 2), "\r\n");
  const lineBefore = text.lastIndexOf("\n", at("crlf").start);
  assert.notEqual(text[lineBefore - 1], "\r", "the line before the CRLF line ends with LF");
}

function checkGrader(): void {
  const variant = variants[0];
  assert.ok(variant);
  const { original, expected } = variantFiles(variant);
  const text = expected.toString("utf8");
  assert.equal(grade(variant, original, expected, Buffer.from(expected)).result, "pass");
  assert.equal(grade(variant, original, expected, Buffer.from(original)).result, "unchanged");
  assert.equal(grade(variant, original, expected, undefined).result, "missing");
  assert.deepEqual(grade(variant, original, expected, Buffer.from(text.slice(1))), {
    result: "wrong",
    intended: true,
    lost: { "BOM U+FEFF": 1 },
    added: {},
    firstDifferentLine: 1,
  });
  // An LF line rewritten to CRLF and a final line break appended.
  const lf = text.indexOf("\n");
  assert.notEqual(text[lf - 1], "\r");
  const crlf = grade(
    variant,
    original,
    expected,
    Buffer.from(text.slice(0, lf) + "\r" + text.slice(lf) + "\n"),
  );
  assert.deepEqual(crlf.added, { "CR U+000D": 1, "LF U+000A": 1 });
  assert.equal(crlf.firstDifferentLine, 1);
  const otherLine = grade(
    variant,
    original,
    expected,
    Buffer.from(original.toString("utf8").replace("checkout-29", "checkout-92")),
  );
  assert.equal(otherLine.intended, false);
  assert.deepEqual([otherLine.lost, otherLine.added], [{}, {}]);
  const nbsp = grade(variant, original, expected, Buffer.from(text.replace(NBSP, " ")));
  assert.deepEqual(nbsp.lost, { "NBSP U+00A0": 1 });
}

function checkArguments(): void {
  const variant = variants[0];
  assert.ok(variant);
  for (const harness of harnesses) {
    const job: Job = { model: "provider/model", thinking: "low", harness, variant, run: 1 };
    const args = piArguments(job);
    const tools = args[args.indexOf("--tools") + 1]?.split(",");
    assert.deepEqual(tools, harness.tools);
    assert.ok(!tools.includes("bash"), `${harness.id} has no bash`);
    assert.equal(args.at(-1), variant.prompt);
    assert.equal(args.at(-2), "--");
    for (const flag of ["--no-extensions", "--no-skills", "--no-context-files", "--no-session"])
      assert.ok(args.includes(flag), `${harness.id} passes ${flag}`);
    assert.equal(args.includes("/source/src/pi-agent-ide.ts"), harness.id === "ide");
  }
  assert.deepEqual(
    ignoredPaths(
      [
        ".tmp/",
        ".husky/_/",
        ".husky/_/husky.sh",
        ".env",
        "node_modules/",
        "packages/a/node_modules/",
      ].join("\0") + "\0",
    ),
    { directories: [".husky/_", ".tmp"], files: [".env"] },
    "the sandbox hides ignored paths but keeps dependencies",
  );
}

/** A scripted executor: each harness writes a known result, so no model or sandbox is needed. */
const scripted: Executor = async (job, trial) => {
  const file = path.join(trial.workspace, FIXTURE_FILE);
  const { expected } = variantFiles(job.variant);
  const outcomes: Record<string, () => Buffer | undefined> = {
    stock: () => expected,
    ide: () => Buffer.from(expected.toString("utf8").slice(1)),
    "stock-2": () => undefined,
  };
  const output = outcomes[job.harness.id + (job.run === 2 ? "-2" : "")]?.();
  if (output) await writeFile(file, output);
  const events = [
    { type: "agent_start" },
    { type: "tool_execution_start", toolName: job.harness.tools[0] },
    {
      type: "tool_execution_end",
      toolName: job.harness.tools[0],
      isError: job.harness.id === "ide",
    },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
  ];
  return {
    code: 0,
    signal: null,
    timedOut: false,
    stdout: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    stderr: "",
    runtime: {
      model: job.model,
      thinking: job.thinking,
      activeTools: job.run === 3 ? ["bash", ...job.harness.tools] : [...job.harness.tools],
    },
  };
};

async function checkRunner(scratch: string): Promise<void> {
  const parent = path.join(scratch, "trials");
  const results = path.join(scratch, "results");
  await mkdir(parent);
  const signal = new AbortController().signal;
  const variant = variants[1];
  assert.ok(variant);
  const rows: Row[] = [];
  for (const harness of harnesses)
    for (const run of [1, 2, 3])
      rows.push(
        await runJob(
          { model: "provider/model", thinking: "low", harness, variant, run },
          { parent, results, executor: scripted, signal },
        ),
      );
  const by = (harness: string, run: number) =>
    rows.find((row) => row.harness === harness && row.run === run);
  assert.equal(by("stock", 1)?.grade.result, "pass");
  assert.equal(by("stock", 1)?.status, "ok");
  assert.equal(by("stock", 2)?.grade.result, "unchanged");
  assert.equal(by("ide", 1)?.grade.result, "wrong");
  assert.deepEqual(by("ide", 1)?.grade.lost, { "BOM U+FEFF": 1 });
  assert.equal(by("ide", 1)?.toolErrors, 1);
  assert.deepEqual(by("ide", 1)?.toolCalls, ["read"]);
  assert.equal(by("stock", 3)?.status, "infra_error", "an undeclared bash fails the run");
  const failing: Executor = async () => {
    throw new Error("sandbox unavailable");
  };
  const failed = await runJob(
    {
      model: "provider/model",
      thinking: "low",
      harness: harnesses[0] ?? assert.fail(),
      variant,
      run: 4,
    },
    { parent, results, executor: failing, signal },
  );
  assert.equal(failed.status, "infra_error");
  assert.equal(failed.grade.result, "unchanged");
  const kept = await readFile(path.join(results, rows[3]?.id ?? "", FIXTURE_FILE), "utf8");
  assert.ok(!kept.startsWith(BOM), "the final file of a run is kept with its results");
  const report = renderReport(rows, variants);
  // Stock run 3 leaves the expected file, but its undeclared bash keeps it from passing.
  assert.ok(report.includes("| provider/model low | stock | - | 1/3 | - | - | 1/3 |"));
  assert.ok(report.includes("| provider/model low | ide | - | 0/3 | - | - | 0/3 |"));
}

/** Deterministic checks of the fixture, the grader and the runner; no model calls. */
export async function selfCheck(temporaryRoot: string): Promise<void> {
  checkFixture();
  checkGrader();
  checkArguments();
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(temporaryRoot, "byte-exact-check-"));
  try {
    await checkRunner(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
