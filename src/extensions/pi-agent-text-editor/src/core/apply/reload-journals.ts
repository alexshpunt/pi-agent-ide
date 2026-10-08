import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { RetainedApplyUndo } from "#src/core/apply/undo-runtime.js";

const key = Symbol.for("pi-agent-text-editor.reload-journals");
interface RetainedSession {
  readonly scope: string;
  readonly session: string;
  readonly owner: RetainedApplyUndo;
}
type SharedGlobal = typeof globalThis & { [key]?: Set<RetainedSession> };
function retained(): Set<RetainedSession> {
  const shared = globalThis as SharedGlobal;
  return (shared[key] ??= new Set());
}

/** Retain only a drained session's journals; no helper or target is started. */
export async function retainSessionApplyUndo(
  core: TextEditorCore,
  scope: string,
  session: string,
): Promise<void> {
  for (const entry of retained()) {
    if (entry.scope !== scope || entry.session !== session) continue;
    await entry.owner.dispose();
    retained().delete(entry);
  }
  const owner = await core.detachApplyUndo();
  retained().add({ scope, session, owner });
}

/** Adopt the matching session only; unrelated sessions release their own journals. */
export async function adoptSessionApplyUndo(
  core: TextEditorCore,
  scope: string,
  session: string,
): Promise<void> {
  for (const entry of retained()) {
    if (entry.scope !== scope) continue;
    if (entry.session === session) await core.adoptApplyUndo(entry.owner);
    else await entry.owner.dispose();
    retained().delete(entry);
  }
}

/** Quit or session replacement releases both current and unclaimed journal owners. */
export async function disposeSessionApplyUndo(core: TextEditorCore, scope: string): Promise<void> {
  await core.disposeApplyUndo();
  for (const entry of retained()) {
    if (entry.scope !== scope) continue;
    await entry.owner.dispose();
    retained().delete(entry);
  }
}
