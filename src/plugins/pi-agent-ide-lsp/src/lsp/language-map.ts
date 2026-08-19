import type { ServerConfig } from "./types.js";

/**
 * Extension → languageId + serverIds mapping.
 *
 * Built once from the registry config. Pure data structure — no I/O.
 */
export interface LanguageLookup
{
    /** Maps extension (with leading dot) to its languageId. */
    extToLanguageId: Map<string, string>;
    /** Maps extension (with leading dot) to its server IDs. */
    extToServerIds: Map<string, string[]>;
}

/**
 * Build the extension→language lookup from server configs.
 *
 * Each server can serve multiple languageIds, each languageId can have
 * multiple extensions. The resulting map is a flat ext→languageId lookup.
 * Extensions must be unique across servers — two servers cannot claim
 * the same extension for different languageIds.
 */
export function buildLanguageLookup(servers: Record<string, ServerConfig>): LanguageLookup
{
    const extToLanguageId = new Map<string, string>();
    const extToServerIds = new Map<string, string[]>();

    for (const [serverId, config] of Object.entries(servers))
    {
        for (const [languageId, lang] of Object.entries(config.languages))
        {
            for (const ext of lang.extensions)
            {
                const normalized = ext.toLowerCase();
                const prevLang = extToLanguageId.get(normalized);

                // Same languageId from different servers is fine (e.g. two servers for TS).
                // Different languageIds for the same extension is a config error.
                if (prevLang !== undefined && prevLang !== languageId)
                {
                    throw new Error(
                        `[lsp] extension conflict: "${normalized}" claimed by "${prevLang}" and "${languageId}"`,
                    );
                }

                extToLanguageId.set(normalized, languageId);

                const serverIds = extToServerIds.get(normalized) ?? [];
                serverIds.push(serverId);
                extToServerIds.set(normalized, serverIds);
            }
        }
    }

    return { extToLanguageId, extToServerIds };
}
