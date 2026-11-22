import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Retain genuine readable Search output, as a caller holding issued selectors would. */
export default function nativeSearchBatchFixture(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, context) => {
    if (event.toolName !== "search") return;
    await mkdir(path.join(context.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(context.cwd, ".pi/issued-search.txt"),
      event.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  });
}
