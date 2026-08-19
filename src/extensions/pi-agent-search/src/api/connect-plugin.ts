import {
    isSearchCoreReady,
    SEARCH_CORE_READY_EVENT,
    SEARCH_PLUGIN_REGISTER_EVENT,
    type SearchPlugin,
    type SearchPluginRegistrationRequest,
} from "#src/api/plugin-protocol.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function connectSearchPlugin(pi: ExtensionAPI, plugin: SearchPlugin): void | Promise<void>
{
    const announce = (): Promise<void> | undefined =>
    {
        let registration: Promise<void> | undefined;
        const request = {
            plugin,
            accept(value): void
            {
                if (registration !== undefined)
                {
                    throw new Error(`Plugin ${plugin.id} registration was accepted more than once`);
                }

                registration = value;
            },
        } satisfies SearchPluginRegistrationRequest;
        pi.events.emit(SEARCH_PLUGIN_REGISTER_EVENT, request);
        return registration;
    };
    let unsubscribe = (): void =>
    {};
    unsubscribe = pi.events.on(SEARCH_CORE_READY_EVENT, (ready) =>
    {
        if (!isSearchCoreReady(ready))
        {
            throw new Error("Invalid pi-agent-search core readiness event");
        }

        const registration = announce();

        if (registration === undefined)
        {
            throw new Error("pi-agent-search core announced readiness without accepting the plugin");
        }

        unsubscribe();
        void registration.catch(() =>
        {});
    });
    pi.on("session_shutdown", unsubscribe);
    const registration = announce();

    if (registration === undefined)
    {
        return;
    }

    unsubscribe();
    return registration;
}
