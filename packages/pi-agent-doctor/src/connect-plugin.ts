import {
  DOCTOR_CORE_READY_EVENT,
  DOCTOR_PLUGIN_REGISTER_EVENT,
  isDoctorCoreReady,
} from "./plugin-protocol.js";

import type { DoctorPlugin, DoctorPluginRegistrationRequest } from "./plugin-protocol.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
Connects an independent extension to doctor regardless of load order.
*/
export function connectDoctorPlugin(pi: ExtensionAPI, plugin: DoctorPlugin): void | Promise<void> {
  const announce = (): Promise<void> | undefined => {
    let registration: Promise<void> | undefined;
    const request = {
      plugin,
      accept(value): void {
        if (registration !== undefined) {
          throw new Error(`Doctor plugin ${plugin.id} was accepted more than once`);
        }

        registration = value;
      },
    } satisfies DoctorPluginRegistrationRequest;
    pi.events.emit(DOCTOR_PLUGIN_REGISTER_EVENT, request);
    return registration;
  };
  let unsubscribe = (): void => {};
  unsubscribe = pi.events.on(DOCTOR_CORE_READY_EVENT, (ready) => {
    if (!isDoctorCoreReady(ready)) {
      throw new Error("Invalid doctor core readiness event");
    }

    const registration = announce();

    if (registration === undefined) {
      throw new Error("Doctor core did not accept the plugin");
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
