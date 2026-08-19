import { access } from "node:fs/promises";
import path from "node:path";

import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

import { createStore, getDefaultDbPath, type HybridQueryResult } from "@tobilu/qmd";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SearchResolver } from "pi-agent-search/api/search";

export default function registerSemanticSearch(pi: ExtensionAPI): void | Promise<void>
{
    return connectSearchPlugin(pi, {
        protocol: SEARCH_PROTOCOL,
        apiVersion: SEARCH_API_VERSION,
        id: "semantic",
        setup(api): void
        {
            api.addResolver({ resolver: semanticResolver() });
            api.describe(
                "Use `semantic:<query>` for conceptual discovery across indexed content when exact terms or paths are unknown. Results provide ranked relevant snippets for further investigation.",
            );
        },
    });
}

function semanticResolver(): SearchResolver
{
    return {
        id: "semantic",
        async tryResolve(request, context)
        {
            if (!request.query.startsWith("semantic:"))
            {
                return { kind: "not-handled" };
            }

            const query = request.query.slice("semantic:".length).trim();

            if (query.length === 0)
            {
                return { kind: "failed", error: new Error("semantic: query must not be empty") };
            }

            const localDirectory = path.join(context.cwd, ".qmd");
            const localConfig = path.join(localDirectory, "index.yml");
            const localYamlConfig = path.join(localDirectory, "index.yaml");
            const configPath = await firstExisting(localConfig, localYamlConfig);
            const dbPath = configPath === undefined ? getDefaultDbPath() : path.join(localDirectory, "index.sqlite");
            const store = await createStore({ dbPath, ...(configPath === undefined ? {} : { configPath }) });

            try
            {
                const results = await store.search({ query, limit: request.limit ?? 10 });
                return { kind: "resolved", payload: { query, results } };
            }
            finally
            {
                await store.close();
            }
        },
        format(payload)
        {
            const { query, results } = payload as {
                readonly query: string;
                readonly results: readonly HybridQueryResult[];
            };

            if (results.length === 0)
            {
                return {
                    content: [{ type: "text", text: "No semantic matches found." }],
                    details: { query, results },
                };
            }

            const lines = results.flatMap((result, index) => [
                `${String(index + 1)}. ${result.title} — qmd://${result.displayPath} #${result.docid} (${
                    result.score.toFixed(3)
                })`,
                result.body.trim().split("\n").slice(0, 6).map((line) => `   ${line}`).join("\n"),
            ]);
            return { content: [{ type: "text", text: lines.join("\n") }], details: { query, results } };
        },
    };
}

async function firstExisting(...files: readonly string[]): Promise<string | undefined>
{
    for (const file of files)
    {
        try
        {
            await access(file);
            return file;
        }
        catch
        {
            // Continue to the next supported local config name.
        }
    }

    return undefined;
}
