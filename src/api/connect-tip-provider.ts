import { isTipCoreReady, TIP_CORE_READY_EVENT, TIP_PROVIDER_REGISTER_EVENT } from "./tips.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TipProvider, TipProviderRegistrationRequest } from "./tips.js";

/**
Connects a startup-tip provider to the built-in core regardless of extension load order.
*/
export function connectTipProvider(pi: ExtensionAPI, provider: TipProvider): void | Promise<void> {
  const announce = (): Promise<void> | undefined => {
    let registration: Promise<void> | undefined;
    const request = {
      provider,
      accept(value): void {
        if (registration !== undefined) {
          throw new Error(`Tip provider ${provider.id} was accepted more than once`);
        }

        registration = value;
      },
    } satisfies TipProviderRegistrationRequest;
    pi.events.emit(TIP_PROVIDER_REGISTER_EVENT, request);
    return registration;
  };

  let unsubscribe = (): void => {};
  unsubscribe = pi.events.on(TIP_CORE_READY_EVENT, (ready) => {
    if (!isTipCoreReady(ready)) {
      throw new Error("Invalid tip core readiness event");
    }

    const registration = announce();
    if (registration === undefined) {
      throw new Error("Tip core did not accept the provider");
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
