import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readPiAgentIdeConfig, resolvePiAgentIdeConfigPath } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () =>
{
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi Agent IDE config", () =>
{
    test("uses the Pi agent directory unless an explicit config path is set", () =>
    {
        expect(resolvePiAgentIdeConfigPath({}, "/home/example")).toBe("/home/example/.pi/agent/pi-agent-ide.json");
        expect(resolvePiAgentIdeConfigPath({ PI_CODING_AGENT_DIR: "/agent" }, "/home/example"))
            .toBe("/agent/pi-agent-ide.json");
        expect(resolvePiAgentIdeConfigPath({ PI_AGENT_IDE_CONFIG: "./custom.json" }, "/home/example"))
            .toBe(path.resolve("custom.json"));
    });

    test("enables every built-in when the config file is absent", async () =>
    {
        const directory = await temporaryDirectory();
        await expect(readPiAgentIdeConfig(path.join(directory, "missing.json")))
            .resolves.toEqual({ disabledExtensions: [] });
    });

    test("reads disabled extension IDs", async () =>
    {
        const directory = await temporaryDirectory();
        const configPath = path.join(directory, "config.json");
        await writeFile(configPath, JSON.stringify({ disabledExtensions: ["search.semantic", "ide.lsp"] }));

        await expect(readPiAgentIdeConfig(configPath)).resolves.toEqual({
            disabledExtensions: ["search.semantic", "ide.lsp"],
        });
    });

    test("rejects malformed disabled extension lists", async () =>
    {
        const directory = await temporaryDirectory();
        const configPath = path.join(directory, "config.json");
        await writeFile(configPath, JSON.stringify({ disabledExtensions: ["ide.lsp", "ide.lsp"] }));

        await expect(readPiAgentIdeConfig(configPath)).rejects.toThrow("must not contain duplicate IDs");
    });
});

async function temporaryDirectory(): Promise<string>
{
    const directory = path.resolve(".agents", "tmp", `config-test-${randomUUID()}`);
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    return directory;
}
