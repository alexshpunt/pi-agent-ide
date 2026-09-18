import { targetsEqual } from "./content-runner.js";
import {
  CONTENT_CONVERTER_REGISTER_EVENT,
  CONTENT_HOST_READY_EVENT,
  type ContentConverterRegistrationRequest,
  isContentHostReady,
} from "./plugin-protocol.js";
import { isContentConverterRegistration } from "./validation.js";

import type { ContentConverterRegistration } from "./content-converter.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function connectContentConverter(
  pi: ExtensionAPI,
  registration: ContentConverterRegistration,
): void | Promise<void> {
  if (!isContentConverterRegistration(registration)) {
    throw new TypeError("Invalid content converter registration");
  }

  const announce = (): Promise<void> | undefined => {
    let accepted: Promise<void> | undefined;
    const request = {
      registration,
      accept(result): void {
        if (accepted !== undefined) {
          throw new Error(
            `Content converter ${registration.converter.id} registration was accepted more than once`,
          );
        }

        accepted = result;
      },
    } satisfies ContentConverterRegistrationRequest;

    pi.events.emit(CONTENT_CONVERTER_REGISTER_EVENT, request);
    return accepted;
  };

  let unsubscribe = (): void => {};
  unsubscribe = pi.events.on(CONTENT_HOST_READY_EVENT, (ready) => {
    if (!isContentHostReady(ready)) {
      throw new Error("Invalid content conversion host readiness event");
    }

    if (!targetsEqual(registration.target, ready.target)) {
      return;
    }

    const accepted = announce();

    if (accepted === undefined) {
      throw new Error(
        `${ready.target.provider}/${ready.target.capability} announced readiness without accepting ` +
          `content converter ${registration.converter.id}`,
      );
    }

    unsubscribe();
    void accepted.catch(() => {});
  });
  pi.on("session_shutdown", unsubscribe);

  const accepted = announce();

  if (accepted === undefined) {
    return;
  }

  unsubscribe();
  return accepted;
}
