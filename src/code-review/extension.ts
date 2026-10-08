import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";
import { afterPostEditScope } from "pi-agent-text-editor/api/post-edit";
import { readReviewRules, REVIEW_RULES_PATH } from "./config.js";
import { createCodeReview } from "./reviewer.js";

/** Connect optional background review and independently gated rule-capture guidance. */
export default async function registerCodeReview(pi: ExtensionAPI): Promise<void> {
  let review: ReturnType<typeof createCodeReview> | undefined;
  const deferredBefore = new Map<string, string>();
  const reset = (ctx: ExtensionContext) => {
    review?.dispose();
    deferredBefore.clear();
    review = createCodeReview({
      enabled: () => pi.getFlag("pi-agent-ide-code-review") === true,
      runtime: () => ({
        available: (signal) =>
          ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal }),
        classify: (model, context, options) => ctx.modelRegistry.classify(model, context, options),
      }),
      rules: readReviewRules,
      current: (file) => readFile(file, "utf8").catch(() => undefined),
      report: (notice) =>
        pi.sendMessage(
          {
            customType: "ide-code-review",
            content: notice.text,
            display: true,
            details: { kind: notice.kind },
          },
          { triggerTurn: notice.kind === "findings", deliverAs: "steer" },
        ),
    });
  };
  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", () => {
    review?.dispose();
    deferredBefore.clear();
  });
  pi.on("before_agent_start", (event) => {
    if (pi.getFlag("pi-agent-ide-code-review-capture") !== true) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nJev rule capture: enabled. Use the capture-code-review-rule skill when the user gives a reusable code-review requirement. Propose the rule and wait for confirmation before saving it to ${REVIEW_RULES_PATH}.`,
    };
  });
  pi.registerMessageRenderer("ide-code-review", (message, options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const text = options.expanded
      ? content
      : [
          ...content.split("\n").slice(0, 2),
          ...content
            .split("\n")
            .filter((line) => /^[a-z][a-z0-9-]*( \(\d+%\):|: insufficient context)/.test(line)),
          "Expand to inspect the rules and checked diff.",
        ].join("\n");
    return new Text(
      theme.fg("toolOutput", text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")),
      0,
      0,
    );
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "jev-code-review",
    setup(api) {
      api.onDidEdit((completion) => {
        const file = completion.resourceSource;
        if (!path.isAbsolute(file) || file === path.resolve(completion.cwd, REVIEW_RULES_PATH))
          return;
        if (completion.postProcessing === "deferred") {
          review?.invalidate(file);
          if (!deferredBefore.has(file)) deferredBefore.set(file, completion.before.content);
          return;
        }
        const before = deferredBefore.get(file) ?? completion.before.content;
        deferredBefore.delete(file);
        const savedReview = review;
        afterPostEditScope(() =>
          savedReview?.schedule({
            file,
            cwd: completion.cwd,
            before,
            after: completion.after.content,
          }),
        );
      });
    },
  });
}
