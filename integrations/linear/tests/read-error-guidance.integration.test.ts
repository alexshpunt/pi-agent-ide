import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const cases = [
  ["ENG-851", "LINEAR_OPERATION_RATE_LIMITED", "rate-limited"],
  ["ENG-852", "LINEAR_CAPABILITIES_UNKNOWN", "recognized safe cause"],
  ["ENG-853", "LINEAR_WORKSPACE_AUTH_REQUIRED", "authorization"],
  ["ENG-854", "LINEAR_ISSUE_ENRICHMENT_PERMISSION_DENIED", "additional issue fields"],
  ["ENG-855", "LINEAR_OPERATION_BACKEND_REJECTED", "cause is unknown"],
  ["ENG-856", "LINEAR_OPERATION_TIMEOUT", "timed out"],
  ["ENG-857", "LINEAR_WORKSPACE_CONNECTION_FAILED", "connection failed"],
  ["ENG-860", "LINEAR_CAPABILITIES_RATE_LIMITED", "fetching the available operations"],
] as const;

// Pattern: the extensions example and normalized-save integration.
// Contract: real AXI failures remain errors while safe stage/cause information crosses Pi's Read boundary.
test("AXI diagnoses reach direct and nested Read without private text or replay", async () => {
  const ide = await currentIde();
  const axiSource = path.resolve(
    process.env.LINEAR_TEST_AXI_SOURCE ?? path.join(root, "packages/linear-axi"),
  );
  const git = promisify(execFile);
  const snapshot = async () => {
    const head = (await git("git", ["-C", axiSource, "rev-parse", "HEAD"])).stdout.trim();
    const files = (
      await git("git", [
        "-C",
        axiSource,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "src",
        "package.json",
        "package-lock.json",
      ])
    ).stdout
      .trim()
      .split("\n")
      .sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file + "\0");
      hash.update(await readFile(path.join(axiSource, file)));
    }
    hash.update("provider-package-lock.json\0");
    hash.update(await readFile(path.join(root, "package-lock.json")));
    return { source: axiSource, head, sourceSha256: hash.digest("hex") };
  };
  const before = await snapshot();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/read-errors-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "safe-linear-read-errors",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 60 },
      timeoutMs: 60000,
      environment: { LINEAR_TEST_AXI_SOURCE: axiSource },
      extensions: [
        ide.extension,
        "builtin:codemode",
        path.join(root, "tests/fixtures/read-error-proof.ts"),
      ],
      tools: ["read", "codemode"],
      conversation: [
        ...cases.map(([identifier]) =>
          assistantMessage(
            [
              toolCall({
                id: identifier,
                name: "read",
                arguments: { path: `linear://example/issue/${identifier}` },
              }),
            ],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage(
          [
            toolCall({
              id: "success",
              name: "read",
              arguments: { path: "linear://example/issue/ENG-858" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "nested",
              name: "codemode",
              arguments: {
                code: 'text(JSON.stringify(await tools.read({path:"linear://example/issue/ENG-859"})));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Failures were diagnosed without replaying the issue reads.")]),
      ],
    }).run(
      "Observe controlled Linear read failures, read one successful issue and do not retry failed requests.",
    );
    await ide.record(result.artifacts.directory);
    const after = await snapshot();
    expect(after).toEqual(before);
    await writeFile(
      path.join(result.artifacts.directory, "axi-source.json"),
      JSON.stringify(after, null, 2),
    );
    for (const [identifier, code, reason] of cases) {
      expect(getToolExecution(result, identifier).isError).toBe(true);
      const message = getToolResultText(result, identifier);
      expect(message).toContain(code);
      expect(message).toContain(reason);
      expect(message).not.toContain("fixture-private-secret");
    }
    expect(getToolExecution(result, "success").isError).toBe(false);
    expect(getToolResultText(result, "success")).toContain("Readable issue");
    expect(getToolResultText(result, "nested")).toContain("LINEAR_OPERATION_UNKNOWN");
    expect(getToolResultText(result, "nested")).toContain("recognized safe cause");
    expect(result.tuiRenderedOutput.replaceAll(/\s+/gu, " ")).toContain("recognized safe cause");
    expect(result.terminalOutput).not.toContain("fixture-private-secret");
    const calls = (await readFile(path.join(cwd, "axi-read-errors.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { identifier?: string; operation?: string });
    for (const identifier of ["ENG-851", "ENG-854", "ENG-855", "ENG-856", "ENG-858", "ENG-859"])
      expect(
        calls.filter((call) => call.identifier === identifier && call.operation === "get_issue"),
      ).toHaveLength(1);
    for (const identifier of ["ENG-852", "ENG-853", "ENG-857", "ENG-860"])
      expect(
        calls.filter((call) => call.identifier === identifier && call.operation === "get_issue"),
      ).toHaveLength(0);
    expect(calls.filter((call) => call.operation === "readIssueEstimate")).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
