import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [group, action] = process.argv.slice(2);
const file = "auth-fixture-state.json";
const initial = {
  state: "connected",
  epoch: "account-a",
  credentialType: "api-key",
  actor: "user",
  identity: {
    id: "user-a",
    name: "Account A",
    workspace: { id: "workspace-1", slug: "example", name: "Example" },
  },
  capabilities: { mcp: true, native: true, storage: true, refresh: false, revoke: false },
};
let current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : initial;
if (group !== "auth") {
  if (current.state === "signed-out") {
    console.log("error: LINEAR_AUTH_REQUIRED");
    process.exit(1);
  }
  if (process.env.LINEAR_AXI_AUTH_EPOCH && process.env.LINEAR_AXI_AUTH_EPOCH !== current.epoch) {
    console.log("error: LINEAR_AUTH_IDENTITY_CHANGED");
    process.exit(1);
  }
  if (group === "documents" && action === "view") {
    console.log(
      `document:\n  id: 71000000-0000-4000-8000-000000000006\n  title: Fixture\n  content: ${JSON.stringify(current.body ?? "Full document\n\nLast line")}\n  url: https://linear.app/example/document/original-request-1234abcd5678`,
    );
  } else if (group === "documents" && action === "update") {
    const index = process.argv.indexOf("--content-file");
    if (index < 0) process.exit(5);
    current.body = readFileSync(process.argv[index + 1], "utf8");
    writeFileSync(file, JSON.stringify(current));
    console.log("updated: true");
  } else await import("./axi.mjs");
} else {
  if (action === "list") {
    const profile = { ...current, connectionId: "11111111-1111-4111-8111-111111111111", name: "Synthetic", method: "api-key" };
    console.log(JSON.stringify({ ...current, connections: current.state === "signed-out" ? [] : [profile] }));
  } else if (action === "epoch")
    console.log(JSON.stringify(process.env.LINEAR_AXI_CONNECTION_ID && process.env.LINEAR_AXI_CONNECTION_ID !== "none" ? { ...current, connectionId: process.env.LINEAR_AXI_CONNECTION_ID } : { epoch: current.epoch, state: current.state }));
  else if (action === "status") console.log(JSON.stringify(current));
  else if (action === "logout") {
    current = { state: "signed-out", epoch: "disconnected" };
    writeFileSync(file, JSON.stringify(current));
    console.log(JSON.stringify(current));
  } else if (action === "login") {
    if (current.state !== "signed-out") process.exit(4);
    console.log(
      JSON.stringify({
        event: "authorization",
        url: "https://mcp.linear.app/authorize?client_id=synthetic-public&state=synthetic-state&code_challenge=synthetic-pkce",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    current = {
      ...initial,
      epoch: "oauth-user",
      credentialType: "oauth",
      scopes: ["read"],
      identity: { ...initial.identity, id: "oauth-user", name: "OAuth account" },
      capabilities: { mcp: true, native: false, storage: false, refresh: true, revoke: false },
    };
    writeFileSync(file, JSON.stringify(current));
    console.log(JSON.stringify({ event: "result", ...current }));
  } else if (action === "revoke") {
    if (process.env.LINEAR_AXI_AUTH_EPOCH !== current.epoch) process.exit(7);
    current = { state: "signed-out", epoch: "retired-before-dispatch" };
    writeFileSync(file, JSON.stringify(current));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(JSON.stringify(current));
  } else if (action === "import") {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    const input = JSON.parse(data);
    if (input.type !== "api-key" || input.token !== "synthetic-key-never-logged") process.exit(2);
    if (process.argv.join(" ").includes(input.token)) process.exit(3);
    current = {
      ...initial,
      epoch: "account-b",
      identity: { ...initial.identity, id: "user-b", name: "Account B" },
    };
    writeFileSync(file, JSON.stringify(current));
    console.log(JSON.stringify(current));
  } else {
    console.log(JSON.stringify({ event: "error", code: "LINEAR_AUTH_REVOKE_UNSUPPORTED" }));
    process.exit(1);
  }
}
