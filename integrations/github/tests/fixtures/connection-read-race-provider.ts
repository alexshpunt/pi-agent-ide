import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import connectionsFixture from "./connections-provider.ts";

const body = "github://example/project/issues/12#body";

/** Switch after the resource supplied A's text, before post-read handlers retain it. */
export default async function connectionReadRaceFixture(pi: ExtensionAPI): Promise<void> {
  await connectionsFixture(pi, async (connections) => {
    let switched = false;
    await connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "github-read-acquisition-race",
      setup(api) {
        api.addHandler({
          stage: "read",
          when: { resolvedBy: "github", contentKind: "text" },
          async handler(context) {
            const state = context.state;
            if (switched || state?.contentKind !== "text" || state.source !== body)
              return { kind: "continue", context };
            switched = true;
            const access = await connections.capture(context.resolverContext.cwd, context.resolverContext.signal);
            await writeFile(path.join(context.resolverContext.cwd, "read-acquisition-race.json"), JSON.stringify({
              source: state.source,
              content: state.text.content,
              profileBeforeSwitch: access.profile.id,
              profileAfterSwitch: "b",
            }));
            connections.useProfile("b");
            return { kind: "continue", context };
          },
        });
      },
    });
  });
}
