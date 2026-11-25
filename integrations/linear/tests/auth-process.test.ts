import { required } from "./fixtures/check.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAuthRunner } from "#linear/auth-process.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(code: string) {
  const root = await mkdtemp(path.join(tmpdir(), "linear-auth-process-"));
  roots.push(root);
  const entry = path.join(root, "cli.mjs");
  await writeFile(entry, code);
  return { root, run: createAuthRunner(async () => entry) };
}
test("app OAuth permission profiles reach the backend unchanged and cannot be used for MCP or user login", async () => {
  const scope = "read,write,comments:create,app:assignable";
  const { root, run } = await fixture(
    `const args=process.argv.slice(2); console.log(JSON.stringify({state:"signed-out",epoch:args[args.indexOf("--scope")+1]}));`,
  );
  await expect(
    run(root, ["login", "--actor", "app", "--method", "oauth", "--scope", scope]),
  ).resolves.toMatchObject({ epoch: scope });
  for (const [actor, method] of [
    ["user", "oauth"],
    ["app", "mcp"],
    ["user", "mcp"],
  ])
    await expect(
      run(root, [
        "login",
        "--actor",
        required(actor),
        "--method",
        required(method),
        "--scope",
        scope,
      ]),
    ).rejects.toThrow("LINEAR_AUTH_INVALID_COMMAND");
});
test("the installed-App command passes a name without accepting credential or scope flags", async () => {
  const { root, run } = await fixture(
    `const args=process.argv.slice(2);if(args[1]!=="connect-app"||args[args.indexOf("--name")+1]!=="Installed app")process.exit(2);console.log(JSON.stringify({state:"signed-out",epoch:"existing-app"}));`,
  );
  await expect(run(root, ["connect-app", "--name", "Installed app"])).resolves.toMatchObject({
    epoch: "existing-app",
  });
  await expect(run(root, ["connect-app", "--scope", "read,write"])).rejects.toThrow(
    "LINEAR_AUTH_INVALID_COMMAND",
  );
});
test("named profiles preserve safe metadata but never return stored tokens", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const { root, run } = await fixture(
    `console.log(JSON.stringify({state:'signed-out',epoch:'list',defaultConnectionId:'${id}',connections:[{connectionId:'${id}',name:'Work key',method:'api-key',state:'connected',credentialType:'api-key',identity:{id:'u1',name:'User',workspace:{id:'w1',slug:'example',name:'Example'}},accessToken:'private-never-returned'}]}));`,
  );
  const result = await run(root, ["list"], { connectionId: "none" });
  expect(result.defaultConnectionId).toBe(id);
  expect(result.connections).toMatchObject([
    { connectionId: id, name: "Work key", method: "api-key" },
  ]);
  expect(JSON.stringify(result)).not.toContain("private-never-returned");
});

test("each backend process receives its own connection selection without changing process.env", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const before = process.env.LINEAR_AXI_CONNECTION_ID;
  const { root, run } = await fixture(
    `console.log(JSON.stringify({state:'signed-out',epoch:process.env.LINEAR_AXI_CONNECTION_ID ?? 'default'}));`,
  );
  const results = await Promise.all([
    run(root, ["epoch"], { connectionId: id }),
    run(root, ["epoch"], { connectionId: "none" }),
  ]);
  expect(results.map((result) => result.epoch)).toEqual([id, "none"]);
  expect(process.env.LINEAR_AXI_CONNECTION_ID).toBe(before);
  await expect(
    run(root, ["epoch"], {
      connectionId: [...Array<string>(2).fill(".".repeat(2)), "bad"].join("/"),
    }),
  ).rejects.toThrow("LINEAR_AUTH_INVALID_COMMAND");
});

test("rename passes a name as a single argument and rejects an unknown selector", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const { root, run } = await fixture(
    `if(process.argv[5]!=='${id}' || process.argv[7]!=='Work key') process.exit(3); console.log(JSON.stringify({state:'signed-out',epoch:'renamed'}));`,
  );
  await expect(run(root, ["rename", "--id", id, "--name", "Work key"])).resolves.toMatchObject({
    epoch: "renamed",
  });
  await expect(
    run(root, ["select", "--id", [...Array<string>(2).fill(".".repeat(2)), "bad"].join("/")]),
  ).rejects.toThrow("LINEAR_AUTH_INVALID_COMMAND");
});
test("secret import travels on stdin and only safe identity fields leave the runner", async () => {
  const { root, run } =
    await fixture(`let input=''; for await (const chunk of process.stdin) input+=chunk;
    const value=JSON.parse(input); if(process.argv.join(' ').includes(value.token)) process.exit(4);
    console.log(JSON.stringify({state:'connected',epoch:'e1',credentialType:'api-key',actor:'user',identity:{id:'u1',name:'User',workspace:{id:'w1',slug:'example',name:'Example'}},capabilities:{mcp:true,native:true,storage:true,refresh:false,revoke:false},access_token:value.token}));`);
  const status = await run(root, ["import"], {
    input: { type: "api-key", token: "secret-never-in-args" },
  });
  expect(status).toMatchObject({ state: "connected", epoch: "e1", identity: { id: "u1" } });
  expect(JSON.stringify(status)).not.toContain("secret-never-in-args");
  expect(status).not.toHaveProperty("access_token");
});
test("an imported OAuth identity can be verified without inventing its actor or scopes", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({state:'connected',epoch:'imported-oauth',credentialType:'oauth',identity:{id:'u1',name:'User',workspace:{id:'w1',slug:'example',name:'Example'}},scopes:[]}));`,
  );
  const value = await run(root, ["status"]);
  expect(value).toMatchObject({
    state: "connected",
    credentialType: "oauth",
    identity: { id: "u1" },
    scopes: [],
  });
  expect(value.actor).toBeUndefined();
});
test("the backend error protocol preserves a safe error without exposing a remote message", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({event:'error',error:'LINEAR_OAUTH_CLIENT_NOT_CONFIGURED',message:'do-not-expose-this'})); process.exit(1)`,
  );
  await expect(run(root, ["login"])).rejects.toThrow(/^LINEAR_OAUTH_CLIENT_NOT_CONFIGURED$/);
});
test("failed commands never expose stderr, stdout or a secret-bearing process error", async () => {
  const { root, run } = await fixture(
    `console.error('token: do-not-expose-this'); process.exit(1)`,
  );
  await expect(run(root, ["status"])).rejects.toThrow(/^LINEAR_AUTH_COMMAND_FAILED$/);
});
test("browser notices accept only a safe Linear authorize URL and require a final result", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({event:'authorization',url:'https://linear.app/oauth/authorize?client_id=public&state=random&code_challenge=test'})); console.log(JSON.stringify({event:'result',state:'connected',epoch:'e2',credentialType:'oauth',actor:'user',identity:{id:'u1',name:'User',workspace:{id:'w1',slug:'example',name:'Example'}}}));`,
  );
  const urls: string[] = [];
  expect(
    await run(root, ["login", "--actor", "user"], { onAuthorization: (url) => urls.push(url) }),
  ).toMatchObject({ state: "connected", epoch: "e2" });
  expect(urls).toHaveLength(1);
});
test("the existing Linear MCP OAuth authorize endpoint needs no shared product client", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({event:'authorization',url:'https://mcp.linear.app/authorize?client_id=dynamic-public&state=random&code_challenge=pkce'})); console.log(JSON.stringify({event:'result',state:'connected',epoch:'mcp-login',credentialType:'oauth',actor:'user',identity:{id:'u1',name:'User',workspace:{id:'w1',slug:'example',name:'Example'}}}));`,
  );
  const urls: string[] = [];
  expect(await run(root, ["login"], { onAuthorization: (url) => urls.push(url) })).toMatchObject({
    state: "connected",
    epoch: "mcp-login",
  });
  expect(urls).toEqual([
    "https://mcp.linear.app/authorize?client_id=dynamic-public&state=random&code_challenge=pkce",
  ]);
});
test("a bearer token in a purported authorization URL is never shown", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({event:'authorization',url:'https://linear.app/oauth/authorize?access_token=secret'}));`,
  );
  const urls: string[] = [];
  await expect(run(root, ["login"], { onAuthorization: (url) => urls.push(url) })).rejects.toThrow(
    /^LINEAR_AUTH_INVALID_RESPONSE$/,
  );
  expect(urls).toEqual([]);
});
test("a connected status without a verified identity is not successful authentication", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({state:'connected',epoch:'missing-identity'}));`,
  );
  await expect(run(root, ["status"])).rejects.toThrow(/^LINEAR_AUTH_INVALID_RESPONSE$/);
});
test("an authorization notice alone cannot become successful login", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({event:'authorization',url:'https://linear.app/oauth/authorize?client_id=public'}));`,
  );
  await expect(run(root, ["login"])).rejects.toThrow(/^LINEAR_AUTH_INVALID_RESPONSE$/);
});
test("confirmed revocation carries its original epoch only through the child environment", async () => {
  const { root, run } = await fixture(
    `if(process.env.LINEAR_AXI_AUTH_EPOCH!=='confirmed-a' || process.argv.includes('confirmed-a')) process.exit(1); console.log(JSON.stringify({state:'signed-out',epoch:'after-revoke'}));`,
  );
  expect(await run(root, ["revoke"], { expectedEpoch: "confirmed-a" })).toMatchObject({
    state: "signed-out",
    epoch: "after-revoke",
  });
});
test("logout revocation forwards only the bounded forget-on-refusal option", async () => {
  const { root, run } = await fixture(
    `if(!process.argv.includes('--forget-on-refusal')) process.exit(1); console.log(JSON.stringify({state:'signed-out',epoch:'after-revoke'}));`,
  );
  expect(
    await run(root, ["revoke", "--forget-on-refusal"], { expectedEpoch: "confirmed-a" }),
  ).toMatchObject({ state: "signed-out" });
  await expect(run(root, ["revoke", "--forget-on-refusal", "--manual"])).rejects.toThrow(
    /^LINEAR_AUTH_INVALID_COMMAND$/,
  );
});
test("JSON auth errors retain only the safe code and ambiguous revoke outcome", async () => {
  const { root, run } = await fixture(
    `console.log(JSON.stringify({event:'error',code:'LINEAR_AUTH_REVOKE_UNKNOWN',effect:'unknown',message:'secret'})); process.exit(1)`,
  );
  await expect(run(root, ["revoke"])).rejects.toThrow(/^LINEAR_AUTH_REVOKE_UNKNOWN$/);
});
