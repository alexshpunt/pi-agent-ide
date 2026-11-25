import { createServer } from "node:http";
import path from "node:path";
import { NamedConnections } from "#linear-axi/src/named-connections.ts";
import { managedAuthCommand } from "#linear-axi/src/commands/managed-auth.ts";

const [group, action, ...rest] = process.argv.slice(2);
const env = {
  ...process.env,
  LINEAR_AXI_CONNECTION_FILE: path.join(process.cwd(), "named-connections.json"),
  LINEAR_AXI_OAUTH_CLIENT_ID: "synthetic-public-client",
};
if (group === "auth" && action === "login") {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  env.LINEAR_AXI_OAUTH_REDIRECT_URI = `http://127.0.0.1:${port}/oauth/callback`;
}
const connection = new NamedConnections({
  env,
  fetchImpl: async (url, init) => {
    if (String(url).endsWith("/oauth/token"))
      return new Response(
        JSON.stringify({
          access_token: "synthetic-browser-key",
          refresh_token: "synthetic-refresh",
          expires_in: 86400,
          scope: "read",
        }),
      );
    const header = new Headers(init?.headers).get("authorization");
    const name =
      header === "synthetic-work-key"
        ? "Work user"
        : header === "synthetic-personal-key"
          ? "Personal user"
          : header === "Bearer synthetic-browser-key"
            ? "Browser user"
            : undefined;
    return new Response(
      JSON.stringify(
        name
          ? {
              data: {
                viewer: {
                  id: name,
                  name,
                  organization: { id: "workspace-1", name: "Example", urlKey: "example" },
                },
              },
            }
          : { errors: [{ message: "Invalid synthetic credential" }] },
      ),
      { status: name ? 200 : 401 },
    );
  },
});
try {
  if (group === "auth") {
    const output = await managedAuthCommand([action, ...rest], {
      env,
      connection,
      stdin: process.stdin,
      stdout: {
        write(value) {
          process.stdout.write(value);
          const event = JSON.parse(value);
          if (event.event === "authorization") {
            const callback = new URL(event.redirectUri);
            callback.searchParams.set("state", new URL(event.url).searchParams.get("state"));
            callback.searchParams.set("code", "synthetic-code");
            setTimeout(() => {
              void fetch(callback).catch(() => {});
            }, 250);
          }
        },
      },
    });
    console.log(output);
  } else if (group === "documents" && action === "view") {
    const selected = await connection.status();
    await connection.authorization();
    await connection.assertEpoch();
    console.log(
      `document:\n  id: 71000000-0000-4000-8000-000000000006\n  title: Fixture\n  content: ${JSON.stringify(selected.identity.name + " document")}\n  url: https://linear.app/example/document/original-request-1234abcd5678`,
    );
  } else throw new Error("LINEAR_AUTH_INPUT_INVALID");
} catch (error) {
  const code = /^LINEAR_[A-Z0-9_]+$/.test(error?.message ?? "")
    ? error.message
    : "LINEAR_AUTH_FAILED";
  console.log(
    group === "auth" ? JSON.stringify({ event: "error", error: code }) : "error: " + code,
  );
  process.exitCode = 1;
}
