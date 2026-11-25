import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { encode } from "@toon-format/toon-v4";
import { NativeRawGraphqlClient, RawGraphqlInputError } from "#linear-axi/src/native-raw-graphql.ts";

const args = process.argv.slice(2);
const argument = key => args[args.indexOf(key) + 1];
const file = "api-fixture.json";
const token = "private-linear-raw-api-fixture-token";
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = state => writeFileSync(file, JSON.stringify(state, null, 2));

if (args[0] === "auth" && args[1] === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
  process.exit(0);
}
appendFileSync("api-axi-calls.jsonl", JSON.stringify(args) + "\n");
const schema = { type: "object", properties: { urlOrId: { type: "string" } }, required: ["urlOrId"], additionalProperties: false };

try {
  if (args[0] === "resources" && args[1] === "capabilities") {
    console.log(encode({ capabilities: { workspace: "example", items: [
      { name: "get_diff", inputSchema: JSON.stringify(schema), annotations: JSON.stringify({ readOnlyHint: true }) },
      { name: "update_diff", inputSchema: JSON.stringify(schema), annotations: "{}" },
      { name: "merge_diff", inputSchema: JSON.stringify(schema), annotations: JSON.stringify({ destructiveHint: true }) },
    ] } }));
  } else if (args[0] === "resources" && args[1] === "invoke") {
    const state = load();
    state.typedMutations.push(args[2]);
    save(state);
    throw new Error("Typed fixture dispatch must remain blocked");
  } else if (args[0] === "api" && args[1] === "graphql") {
    const input = JSON.parse(readFileSync(argument("--input-file"), "utf8"));
    const client = new NativeRawGraphqlClient({
      tokenProvider: {
        getAuthorization: async () => "Bearer " + token,
        assertCurrentAuthorization: async () => {},
      },
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const authenticated = new Headers(init?.headers).get("authorization") === "Bearer " + token;
        if (url.href !== "https://api.linear.app/graphql" || !authenticated || init?.redirect !== "error")
          throw new Error("Fixture rejected an untrusted transport");
        const body = JSON.parse(String(init?.body));
        const state = load();
        const scope = body.query.startsWith("query RawGraphqlWorkspace ");
        state.requests.push({ kind: scope ? "scope" : "raw", url: url.href, authenticated, body });
        if (scope) {
          save(state);
          return Response.json({ data: { viewer: { organization: {
            id: "10000000-0000-4000-8000-000000000001", urlKey: "example",
          } } } });
        }
        const reply = payload => { save(state); return Response.json(payload); };
        if (body.operationName === "FixtureQuery") return reply({ data: {
          fixture: { id: body.variables.id, value: state.value, detail: "outside-selected-fixture-marker" },
          operationName: body.operationName,
        } });
        if (body.operationName === "FixtureReaction") {
          state.value = "Raw mutation fixture";
          state.reaction = { id: body.variables.input.id, emoji: body.variables.input.emoji };
          return reply({ data: { reactionCreate: { success: true, reaction: state.reaction } } });
        }
        if (body.operationName === "FixtureUnknown") {
          state.value = "Unknown mutation saved";
          save(state);
          throw new Error(token);
        }
        if (body.operationName === "FixturePartial") {
          state.value = body.variables.value;
          return reply({ data: { changed: { id: "FIXTURE_17", value: state.value } },
            errors: [{ message: "Fixture rejected credential " + token, path: ["secondary"], extensions: { code: "FIXTURE_ERROR" } }],
            extensions: { fixture: "Retained partial extension" },
          });
        }
        throw new Error("Unexpected raw fixture operation");
      },
    });
    console.log(JSON.stringify({ graphql: await client.execute(input, argument("--workspace")) }));
  } else throw new Error("Unexpected fixture command");
} catch (error) {
  const code = error instanceof RawGraphqlInputError && /^LINEAR_[A-Z_]+$/u.test(error.message)
    ? error.message : "LINEAR_GRAPHQL_FIXTURE_FAILED";
  console.log(encode({ error: code, effect: error instanceof RawGraphqlInputError ? "not-applied" : "unknown" }));
  process.exitCode = 1;
}
