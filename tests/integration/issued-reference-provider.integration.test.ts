import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("issued references survive split argument tokens and independent tool calls", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
    await writeFile(path.join(cwd, "source.txt"), 'first "quoted" \\ path\nsecond café 😀\n');
    await writeFile(path.join(cwd, "other.txt"), "another result\n");
    const token = "$issued-result:source-long-id";
    const explicit = JSON.stringify({ path: "explicit.txt", content: token });
    const split = explicit.indexOf(token) + "$issued-result:source".length;
    const progressivePrefix = JSON.stringify({ path: "progressive.txt", content: token }).slice(
      0,
      -1,
    );
    const defaultPrefix = "x".repeat(
      1024 - JSON.stringify({ path: "default.txt", content: "" }).indexOf('"}') - 8,
    );
    const run = await new PiIntegrationTest({
      testName: "issued-reference-chunks",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/issued-reference-probe.ts"),
      ],
      tools: ["read", "issued_reference_probe"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "source-long-id",
              name: "read",
              arguments: { path: "source.txt", views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "other", name: "read", arguments: { path: "other.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "characters",
              name: "issued_reference_probe",
              arguments: {
                path: "characters.txt",
                content: `${token}\n$issued-uuid:source-long-id\n$issued-anchor:source-long-id:2\n${token}`,
              },
              chunks: { kind: "characters" },
              delayMs: 0,
            }),
            toolCall({
              id: "explicit",
              name: "issued_reference_probe",
              argumentsJson: explicit,
              argumentSnapshots: [{ path: "explicit.txt", content: "$issued-result:source" }],
              chunks: {
                kind: "explicit",
                chunks: [explicit.slice(0, split), explicit.slice(split)],
              },
              delayMs: 0,
            }),
            toolCall({
              id: "default",
              name: "issued_reference_probe",
              arguments: { path: "default.txt", content: defaultPrefix + token },
            }),
            toolCall({
              id: "progressive",
              name: "issued_reference_probe",
              argumentsJson: progressivePrefix + "}",
              chunks: { kind: "explicit", chunks: [progressivePrefix, "}"] },
              delayMs: 0,
            }),
            toolCall({
              id: "no-end",
              name: "issued_reference_probe",
              arguments: { path: "no-end.txt", content: "$issued-result:other" },
              chunks: { kind: "fixed", size: 3 },
              delayMs: 0,
              includeEnd: false,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Replay issued references with several argument chunk schedules.");
    for (const id of ["source-long-id", "other", "characters", "explicit", "default", "no-end"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const shown = getToolResultText(run, "source-long-id");
    const uuid = /<uuid>([^<]+)<\/uuid>/u.exec(shown)?.[1];
    const secondAnchor = [...shown.matchAll(/(?:^|\n)\s*([A-Z\d]{7})\|/gu)][1]?.[1];
    expect(uuid).toBeDefined();
    expect(secondAnchor).toBeDefined();
    const expected = {
      characters: `${shown}\n${uuid}\n${secondAnchor}\n${shown}`,
      explicit: shown,
      progressive: shown,
      default: defaultPrefix + shown,
      "no-end": getToolResultText(run, "other"),
    };
    for (const [id, content] of Object.entries(expected)) {
      expect(getToolExecutionDetails(getToolExecution(run, id))).toMatchObject({ content });
      const deltas = run.traceEvents.flatMap((event) => {
        const update = (
          event.event as { assistantMessageEvent?: AssistantMessageEvent } | undefined
        )?.assistantMessageEvent;
        if (update?.type !== "toolcall_delta") return [];
        const call = update.partial.content[update.contentIndex];
        return call?.type === "toolCall" && call.id === id ? [update.delta] : [];
      });
      expect(JSON.parse(deltas.join(""))).toMatchObject({ content });
      if (id === "progressive") {
        expect(deltas).toEqual([
          JSON.stringify({ path: "progressive.txt", content: shown }).slice(0, -1),
          "}",
        ]);
      }
    }
  });
});
