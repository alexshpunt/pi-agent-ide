import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isReadCoreReady,
  READ_CORE_READY_EVENT,
  READ_PLUGIN_REGISTER_EVENT,
  type ReadPlugin,
  type ReadPluginRegistrationRequest,
} from "#src/api/plugin-protocol.js";

export function connectReadPlugin(pi: ExtensionAPI, plugin: ReadPlugin): void | Promise<void> {
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
    } satisfies ReadPluginRegistrationRequest;

    pi.events.emit(READ_PLUGIN_REGISTER_EVENT, request);
    return registration;
  };

  let unsubscribe = (): void => {};
  unsubscribe = pi.events.on(READ_CORE_READY_EVENT, (ready) => {
    if (!isReadCoreReady(ready)) {
      throw new Error("Invalid pi-agent-read core readiness event");
    }

    const registration = announce();

    if (registration === undefined) {
      throw new Error("pi-agent-read core announced readiness without accepting the plugin");
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
