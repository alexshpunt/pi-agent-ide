import {
  isTipProviderRegistrationRequest,
  TIP_API_VERSION,
  TIP_CORE_READY_EVENT,
  TIP_PROTOCOL,
  TIP_PROVIDER_REGISTER_EVENT,
} from "#src/api/tips.js";

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TipContext } from "#src/api/tips.js";

import { TipCallout } from "./tip-callout.js";
import { TipCore } from "./core.js";
import { normalizeProjectPath, TipStateStore } from "./persistence.js";

const TIP_ENTRY_TYPE = "pi-agent-ide-startup-tip";

/** Registers the built-in startup-tip core and passive TUI renderer. */
export default function registerTips(pi: ExtensionAPI): void {
  const core = new TipCore();
  const state = new TipStateStore();
  pi.registerEntryRenderer(TIP_ENTRY_TYPE, (entry, _options, theme) => {
    const tip = entry.data as { readonly title?: string; readonly body?: string };
    if (typeof tip.title !== "string" || typeof tip.body !== "string") {
      return undefined;
    }
    return new TipCallout({ title: tip.title, body: tip.body }, theme);
  });
  const unsubscribe = pi.events.on(TIP_PROVIDER_REGISTER_EVENT, (request) => {
    if (!isTipProviderRegistrationRequest(request)) {
      throw new Error("Invalid tip provider registration request");
    }

    request.accept(core.registerProvider(request.provider));
  });
  pi.on("session_shutdown", unsubscribe);

  let controller: AbortController | undefined;
  let pending = Promise.resolve();
  pi.on("session_start", (event, context) => {
    controller?.abort();
    controller = new AbortController();
    // Hints are optional. Session readiness never waits for project inspection.
    const signal = controller.signal;
    pending = pending
      .then(() => displayTip(pi, core, state, event.reason, context, signal))
      .catch(() => {});
  });
  pi.on("session_shutdown", async () => {
    controller?.abort();
    await pending;
  });

  pi.events.emit(TIP_CORE_READY_EVENT, {
    protocol: TIP_PROTOCOL,
    apiVersion: TIP_API_VERSION,
  });
}

async function displayTip(
  pi: ExtensionAPI,
  core: TipCore,
  state: TipStateStore,
  reason: TipContext["reason"],
  context: ExtensionContext,
  signal: AbortSignal,
): Promise<void> {
  if (context.mode !== "tui") {
    return;
  }
  signal.throwIfAborted();

  if (core.isEmpty) {
    return;
  }

  const contributions = await core.collectTips({
    cwd: context.cwd,
    mode: context.mode,
    hasUI: context.hasUI,
    signal,
    reason,
  });
  signal.throwIfAborted();
  if (contributions.length === 0) {
    return;
  }

  const project = normalizeProjectPath(context.cwd);
  for (const contribution of contributions) {
    const identity = tipIdentity(contribution.providerId, contribution.tip.id);
    if (!(await state.claimIfUnseen(project, identity, contribution.tip.id))) {
      continue;
    }

    if (signal.aborted) {
      await state.unmarkShown(project, identity);
      return;
    }

    try {
      // The entry renderer also draws live entries. A widget here would show
      // the same late tip twice: once in the transcript and once above the editor.
      pi.appendEntry(TIP_ENTRY_TYPE, contribution.tip);
      return;
    } catch (error) {
      await state.unmarkShown(project, identity);
      throw error;
    }
  }
}

function tipIdentity(providerId: string, tipId: string): string {
  return JSON.stringify([providerId, tipId]);
}
