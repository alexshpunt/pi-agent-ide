import {
  IDE_CORE_READY_EVENT,
  IDE_PLUGIN_REGISTER_EVENT,
  type IdePlugin,
  type IdePluginRegistrationRequest,
  isIdeCoreReady,
} from "#src/api/plugin-protocol.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function connectIdePlugin(pi: ExtensionAPI, plugin: IdePlugin): void | Promise<void> {
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
    } satisfies IdePluginRegistrationRequest;

    pi.events.emit(IDE_PLUGIN_REGISTER_EVENT, request);
    return registration;
  };

  let unsubscribe = (): void => {};
  unsubscribe = pi.events.on(IDE_CORE_READY_EVENT, (ready) => {
    if (!isIdeCoreReady(ready)) {
      throw new Error("Invalid pi-agent-ide core readiness event");
    }

    const registration = announce();

    if (registration === undefined) {
      throw new Error("pi-agent-ide core announced readiness without accepting the plugin");
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
