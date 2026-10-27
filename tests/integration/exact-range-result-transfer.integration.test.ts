import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

for (const route of ["direct", "codemode"] as const) {
  test(`result-source transfers preserve selected bytes through ${route}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
      );
      const selected = "段🙂\r\n尾🙂";
      const source = `keep\r\n${selected}`;
      const target = "left TARGET right\n";
      const files = {
        "copy-source.txt": source,
        "move-source.txt": source,
        "copy-target.txt": target,
        "move-target.txt": target,
        "inline-target.txt": target,
      };
      await Promise.all(
        Object.entries(files).map(([file, content]) => writeFile(path.join(cwd, file), content)),
      );
      const transfers = [
        { tool: "copy", source: "copy-source.txt", target: "copy-target.txt", paired: true },
        { tool: "move", source: "move-source.txt", target: "move-target.txt", paired: true },
        { tool: "copy", source: "copy-source.txt", target: "inline-target.txt", paired: false },
      ];
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      const conversation =
        route === "direct"
          ? transfers.flatMap((transfer, index) => [
              call(`read-${index}`, "read", { path: transfer.source, offset: 2, limit: 2 }),
              call(`transfer-${index}`, transfer.tool, {
                path: "$previous-uuid",
                target: transfer.target,
                targetStart: "TARGET",
                ...(transfer.paired ? { targetEnd: "TARGET" } : {}),
              }),
            ])
          : [
              call("transfer", "codemode", {
                code: `for (const transfer of ${JSON.stringify(transfers)}) { const selected = await tools.read({path:transfer.source,offset:2,limit:2}); text(await tools[transfer.tool]({path:selected,target:transfer.target,targetStart:"TARGET",...(transfer.paired?{targetEnd:"TARGET"}:{})})); }`,
              }),
            ];
      const result = await new PiIntegrationTest({
        cwd,
        testName: `exact-range-result-transfer-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        extensions: [
          path.resolve("tests/integration/fixtures/forward-text-result.ts"),
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
        ],
        tools: ["read", "copy", "move", "codemode"],
        isolateUserResources: true,
        rawMode: false,
        conversation: [
          ...conversation,
          assistantMessage([text("Completed the result-source transfers.")]),
        ],
      }).run(
        "Transfer the returned Read selections without normalizing their bytes or widening their boundaries.",
      );
      const ids =
        route === "direct"
          ? transfers.flatMap((_, index) => [`read-${index}`, `transfer-${index}`])
          : ["transfer"];
      for (const id of ids) expect(getToolExecution(result, id).isError).toBe(false);
      const expected = {
        "copy-source.txt": source,
        "move-source.txt": "keep\r\n",
        "copy-target.txt": `left ${selected} right\n`,
        "move-target.txt": `left ${selected} right\n`,
        "inline-target.txt": `left TARGET${selected} right\n`,
      };
      for (const [file, content] of Object.entries(expected))
        expect(await readFile(path.join(cwd, file)), file).toEqual(Buffer.from(content));
    });
  }, 120_000);
}
