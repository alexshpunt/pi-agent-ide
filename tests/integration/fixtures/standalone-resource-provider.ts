import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { confirmOperation } from "pi-agent-ide/api/approval";
import { createStandaloneResourceHost } from "pi-agent-ide/api/standalone";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import { connectTextEditorPlugin, TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-ide/api/text-editor";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import type { ResourceResolver } from "pi-agent-ide/api/resource";

/** An external URI provider, not a filesystem plugin or a second editor implementation. */
export default async function provider(pi: ExtensionAPI): Promise<void> {
  for (const name of ["demo", "other"]) {
    const host = await createStandaloneResourceHost(pi, {
      namespace: { name, description: "Read and change the fixture's owned memory resources." },
      ownsSource: (source) => source.startsWith(`memory://${name}/`),
    });
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    pi.registerCommand(`approval_${name}`, {
      description: "Request a harmless provider operation through the shared service.",
      async handler(category, context) {
        const controller = new AbortController();
        if (category === "cancel") controller.abort();
        const approved = await confirmOperation(host.api.events, context, {
          owner: name, category: category || "edit", title: "Fixture permission", message: name,
          signal: controller.signal,
        });
        await writeFile(path.join(context.cwd, `approval-${name}.json`), JSON.stringify({ approved }));
      },
    });
    const resolver: ResourceResolver = {
      id: `${name}-memory`,
      async tryResolve(source, context) {
        if (!source.startsWith(`memory://${name}/`) || source.endsWith("/missing"))
          return { kind: "not-handled" };
        const file = path.join(context.cwd, name === "demo" ? "resource.txt" : "other.txt");
        let snapshot = await readFile(file, "utf8");
        return {
          kind: "resolved",
          resource: {
            source,
            sourceBytes: Buffer.from(snapshot),
            skipPostEdit: true,
            read: async () => [{ type: "text", text: snapshot }],
            async write(blocks) {
              if (await readFile(file, "utf8") !== snapshot) throw new Error("Fixture snapshot changed");
              if (blocks.length !== 1 || blocks[0].type !== "text") throw new Error("Text only");
              snapshot = blocks[0].text;
              await writeFile(file, snapshot);
            },
          },
        };
      },
    };
    await connectReadPlugin(host.api, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: `${name}-memory`,
      setup(api) { api.addResolver({ resolver }); },
    });
    await connectTextEditorPlugin(host.api, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: `${name}-memory`,
      setup(api) {
        api.addResolver({ resolver });
        api.addMutationGuard({
          id: `${name}-pause`,
          async guard(plan) {
            if (plan.resources.some((resource) => resource.source.endsWith("/delayed"))) {
              entered();
              await paused;
            }
            return { kind: "accepted" };
          },
        });
      },
    });
    pi.registerTool({
      name: `cancel_${name}`,
      label: `Cancel ${name}`,
      description: "Pause a write, retire its host and check cancellation before publication.",
      parameters: Type.Object({}),
      async execute(_id, _args, _signal, _update, context) {
        const mutation = context.executeTool(`${name}_write`, {
          path: `memory://${name}/delayed`, content: "must not publish",
        }).then((result) => result.isError === true, () => true);
        await ready;
        const disposal = host.dispose(context);
        release();
        const rejected = await mutation;
        await disposal;
        if (!rejected) throw new Error("Disposed host published a paused mutation");
        return { content: [{ type: "text", text: "Pending mutation cancelled" }], details: undefined };
      },
    });
    connectAgentDocumentation(host.api, [{
      id: name,
      description: "Fixture resource guide",
      markdown: `# Demo resources\n\nUse memory://${name}/note to read or change the fixture text.\n`,
      triggers: [{ tool: "read", resourcePrefixes: [`memory://${name}/`] }],
    }]);
    pi.registerTool({
      name: `dispose_${name}`,
      label: `Dispose ${name}`,
      description: "Retire the fixture host.",
      parameters: Type.Object({}),
      async execute(_id, _args, _signal, _update, context) {
        await host.dispose(context);
        return { content: [{ type: "text", text: "Host disposed" }], details: undefined };
      },
    });
  }
}
