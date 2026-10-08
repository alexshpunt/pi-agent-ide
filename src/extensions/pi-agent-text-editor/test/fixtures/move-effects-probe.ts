import { readFile } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Fail Move only for marked, disposable fixtures in the isolated test process. */
export default async function registerMoveEffectsProbe(pi: ExtensionAPI): Promise<void> {
  let fixtureDirectory: string | undefined;
  pi.on("session_start", (_event, context) => {
    fixtureDirectory = path.resolve(context.cwd, ".tmp/move-effects");
  });
  const originalMove = fs.move;
  const injectedMove = new Proxy(originalMove, {
    apply(move, receiver, args) {
      const [source, target] = args;
      if (typeof source !== "string" || typeof target !== "string")
        return Reflect.apply(move, receiver, args);
      const directory = path.dirname(source);
      const name = path.basename(source);
      if (
        directory !== fixtureDirectory ||
        !["unknown-before.txt", "unknown-after.txt"].includes(name) ||
        target !== path.join(directory, name.replace(".txt", "-target.txt"))
      )
        return Reflect.apply(move, receiver, args);
      return (async () => {
        const marker = await readFile(path.join(directory, "owned.txt"), "utf8");
        if (marker !== "LPT-642 disposable fixtures\n")
          throw new Error("Move probe requires its owned fixture marker");
        if (name === "unknown-after.txt") await Reflect.apply(move, receiver, args);
        throw new Error("Injected Move primitive failure in an owned fixture");
      })();
    },
  });
  fs.move = injectedMove;
  pi.on("session_shutdown", () => {
    if (fs.move === injectedMove) fs.move = originalMove;
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-move-effects",
    setup(api) {
      api.addTextPresenter({
        presenter: {
          id: "fixture-move-receipt-failure",
          async present(document, context) {
            const directory = path.resolve(context.cwd, ".tmp/move-effects");
            if (
              context.purpose !== "edit-diff" ||
              document.source !== path.join(directory, "text-target.txt")
            )
              return document;
            const marker = await readFile(path.join(directory, "owned.txt"), "utf8");
            if (marker !== "LPT-642 disposable fixtures\n") return document;
            return {
              ...document,
              get content(): string {
                throw new Error("Injected Move receipt failure after saving text");
              },
            };
          },
        },
      });
    },
  });
}
