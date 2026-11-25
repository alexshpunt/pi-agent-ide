import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "#axi/cli.ts";
import { decode } from "@toon-format/toon-v4";
import { formatError } from "#axi/cli.ts";
import { RawGraphqlInputError } from "#axi/native-raw-graphql.ts";
import type { Runtime } from "#axi/types.ts";
import type { RawGraphqlReceipt } from "#axi/native-raw-graphql.ts";
import { unexpectedSearch } from "./fixtures/native-search.ts";

void test("raw validation failures retain their known effect through the existing CLI error protocol", () => {
  const error = new RawGraphqlInputError();
  const formatted = formatError(error);
  assert.equal(formatted.exitCode, 1);
  assert.deepEqual(decode(formatted.output), { error: error.message, effect: "not-applied" });
});
// The native gateway owns App identity and workspace verification. MCP is unavailable here.
void test("raw GraphQL CLI forwards an arbitrary mutation with variables and operation selection to the native App", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-raw-graphql-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    query:
      "mutation FixtureReaction($input: ReactionCreateInput!) { reactionCreate(input: $input) { success reaction { id emoji } } }",
    variables: {
      input: {
        id: "20000000-0000-4000-8000-000000000002",
        commentId: "10000000-0000-4000-8000-000000000001",
        emoji: "thumbsup",
      },
    },
    operationName: "FixtureReaction",
  };
  const file = path.join(directory, "input.json");
  await writeFile(file, JSON.stringify(input), { mode: 0o600 });
  const nativeCalls: Array<{ input: unknown; workspace: string }> = [];
  const mcpCalls: string[] = [];
  const response: RawGraphqlReceipt = {
    workspace: "example",
    operationType: "mutation",
    status: 200,
    effect: "applied",
    data: {
      reactionCreate: {
        success: true,
        reaction: { id: input.variables.input.id, emoji: input.variables.input.emoji },
      },
    },
  };
  const runtime: Runtime = {
    cwd: directory,
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://mcp.example.invalid",
    client: {
      listTools: async () => {
        mcpCalls.push("listTools");
        throw new Error("Fixture MCP is unavailable");
      },
      callTool: async (name: string) => {
        mcpCalls.push(name);
        throw new Error("Fixture MCP is unavailable");
      },
    },
    searchClient: {
      searchObjects: unexpectedSearch,
      executeGraphql: async (request: unknown, workspace: string) => {
        nativeCalls.push({ input: request, workspace });
        return response;
      },
    },
  };

  let output: string | undefined;
  let failure: unknown;
  try {
    output = await run(["api", "graphql", "--workspace", "example", "--input-file", file], runtime);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure, undefined);
  assert.equal(nativeCalls.length, 1, "The raw request must reach the native gateway once");
  assert.deepEqual(nativeCalls, [{ input, workspace: "example" }]);
  assert.deepEqual(mcpCalls, []);
  assert(typeof output === "string");
  assert.ok(output.includes(input.variables.input.id));
  assert.deepEqual(JSON.parse(output), { graphql: response });
});
