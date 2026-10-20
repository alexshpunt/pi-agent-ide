import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

type Document = Component & {
  pane: string;
  source: { children: Array<{ render(width: number): string[] }> };
  beginFrame(): void;
  searchEntries(): Array<{ text: string }>;
};

/** Observe the unchanged consumer and native history without adding visible test output. */
export default function captureReview(pi: ExtensionAPI): void {
  let tui: TUI & { layoutRoot: Component; getScreenLines(): string[] };
  pi.on("session_start", async (_event, ctx) => {
    let finish = () => {};
    await ctx.ui.custom<void>(
      (host, _theme, _keys, done) => {
        tui = host as typeof tui;
        finish = done;
        return new Text("", 0, 0);
      },
      {
        overlay: true,
        overlayOptions: { visible: () => false, nonCapturing: true },
        onHandle: () => finish(),
      },
    );
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await new Promise<void>((resolve, reject) => {
      const write = tui.terminal.write;
      const restore = () => {
        tui.terminal.write = write;
        clearTimeout(timeout);
      };
      const timeout = setTimeout(() => {
        restore();
        reject(new Error("No native capture frame"));
      }, 5000);
      tui.terminal.write = (data) => {
        write.call(tui.terminal, data);
        if (data.includes("\x1b[?2026l")) {
          restore();
          resolve();
        }
      };
      tui.requestRender(true);
    });
    const documents: Document[] = [];
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") {
        documents.push(component as Document);
        return;
      }
      const owner = component as Component & { children?: Component[]; child?: Component };
      for (const child of owner.children ?? []) visit(child);
      if (owner.child) visit(owner.child);
    };
    visit(tui.layoutRoot);
    const panes: Record<string, string[]> = {};
    const search: Record<string, string[]> = {};
    for (const document of documents) {
      document.beginFrame();
      panes[document.pane] = document.render(200);
      search[document.pane] = document.searchEntries().map((entry) => entry.text);
    }
    const history = documents[0]?.source.children[2];
    await writeFile(
      path.join(ctx.cwd, "review-capture.json"),
      JSON.stringify({
        panes,
        search,
        native: history?.render(200),
        screen: tui.getScreenLines(),
      }),
    );
  });
}
