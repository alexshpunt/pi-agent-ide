import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isTextEditorCoreReady,
  TEXT_EDITOR_CORE_READY_EVENT,
  TEXT_EDITOR_PLUGIN_REGISTER_EVENT,
  type TextEditorPlugin,
  type TextEditorPluginRegistrationRequest,
} from "#src/api/plugin-protocol.js";

export function connectTextEditorPlugin(
  pi: ExtensionAPI,
  plugin: TextEditorPlugin,
): void | Promise<void> {
  const announce = (): Promise<void> | undefined => {
    let registration: Promise<void> | undefined;
    const request = {
      plugin,
      accept(value): void {
        if (registration !== undefined) {
          throw new Error(`Plugin ${plugin.id} registration was accepted more than once`);
        }

        registration = value;
      },
    } satisfies TextEditorPluginRegistrationRequest;

    pi.events.emit(TEXT_EDITOR_PLUGIN_REGISTER_EVENT, request);
    return registration;
  };

  let unsubscribe = (): void => {};
  unsubscribe = pi.events.on(TEXT_EDITOR_CORE_READY_EVENT, (ready) => {
    if (!isTextEditorCoreReady(ready)) {
      throw new Error("Invalid pi-agent-text-editor core readiness event");
    }

    const registration = announce();

    if (registration === undefined) {
      throw new Error("pi-agent-text-editor core announced readiness without accepting the plugin");
    }

    unsubscribe();
    void registration.catch(() => {});
  });
  pi.on("session_shutdown", unsubscribe);

  const registration = announce();

  if (registration === undefined) {
    return;
  }

  unsubscribe();
  return registration;
}
