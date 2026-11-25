import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { registerGithubProvider } from "#github/index.ts";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";

const route = "/repos/example/project/issues/12";
const marker = "rate-fixture-private-upstream-payload";
const token = (owner: string) => `rate-fixture-private-credential-${owner}`;

/** The real HTTP boundary is local and bounded; no real GitHub credentials or service are used. */
export default async function rateLimitFixture(pi: ExtensionAPI): Promise<void> {
  let cwd = process.cwd();
  let owner: "limited" | "other" = "limited";
  let server: Server | undefined;
  let ready: Promise<string> | undefined;
  const requests: { method: string; route: string; owner: string }[] = [];
  const coordinator = new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 });
  pi.on("session_start", (_event, context) => { cwd = context.cwd; });
  const start = (): Promise<string> => ready ??= new Promise((resolve, reject) => {
    server = createServer(async (request, response) => {
      const actor = request.headers.authorization === `Bearer ${token("limited")}` ? "limited"
        : request.headers.authorization === `Bearer ${token("other")}` ? "other" : undefined;
      if (request.method !== "GET" || request.url !== route || !actor) {
        response.writeHead(400).end();
        return;
      }
      requests.push({ method: request.method, route: request.url, owner: actor });
      try {
        await writeFile(path.join(cwd, "rate-limit-http.json"), JSON.stringify({ requests }));
        if (actor === "limited") {
          response.writeHead(429, {
            "content-type": "application/json", "retry-after": "60",
            "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-resource": "core",
            "x-private-debug": marker,
          }).end(JSON.stringify({ message: marker }));
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            id: 12, number: 12, title: "Quota-owner fixture", body: "other-owner-readable-body",
            state: "open", updated_at: "fixture-revision", labels: [], assignees: [], milestone: null,
            html_url: "https://github.com/example/project/issues/12",
            repository_url: "https://api.github.com/repos/example/project",
          }));
        }
      } catch { response.writeHead(500).end(); }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") { reject(new Error("Missing local HTTP fixture address")); return; }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  const makeClient = () => {
    const capturedOwner = owner;
    return new GithubClient({
      quotaOwner: `user:rate-fixture-${capturedOwner}`,
      identity: { login: `rate-fixture-${capturedOwner}`, name: "Rate fixture", email: "fixture@example.invalid" },
      async initialize() {},
      async getToken() { return { token: token(capturedOwner), expiresAt: Date.now() + 3_600_000 }; },
    }, {
      coordinator,
      fetcher: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin !== "https://api.github.com" || url.pathname !== route || url.search || init?.method !== "GET")
          throw new Error("Rate fixture rejected an external or unexpected request");
        return fetch((await start()) + route, { ...init, redirect: "error" });
      },
    });
  };
  let client = makeClient();
  pi.on("session_shutdown", async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  });
  // Negative verification can suppress only the provider's public result hooks, not its transport or SDK.
  const registration = process.env.PI_RATE_FIXTURE_OMIT_PRESENTATION === "1" ? new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "on") return (event: string, ...args: unknown[]) => event === "tool_result"
        ? () => {} : Reflect.apply(target.on, target, [event, ...args]);
      return Reflect.get(target, property, receiver);
    },
  }) : pi;
  await registerGithubProvider(registration, new GithubBackend(async () => client));
  pi.registerTool({
    name: "rate_fixture_owner", label: "Fixture owner", description: "Test-only credential-generation change.",
    parameters: Type.Object({ owner: Type.Union([Type.Literal("limited"), Type.Literal("other")]) }),
    async execute(_id, args) {
      owner = args.owner;
      client = makeClient();
      return { content: [{ type: "text", text: JSON.stringify({ owner }) }], details: { owner } };
    },
  });
}
