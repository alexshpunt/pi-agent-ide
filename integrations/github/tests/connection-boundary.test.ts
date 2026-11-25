import { describe, expect, it } from "vitest";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { createGithubResolver } from "#github/resource.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";
import { fenceGithubResolver } from "#github/connections/boundary.ts";
import type {
  GithubConnectionAccess,
  GithubConnectionBoundary,
} from "#github/connections/manager.ts";

function boundary() {
  let generation = 0;
  let controller = new AbortController();
  const access: GithubConnectionBoundary = {
    async capture() {
      const expected = generation;
      return {
        signal: controller.signal,
        assertCurrent() {
          if (expected !== generation) throw new Error("GH_CONNECTION_CHANGED");
        },
      } as GithubConnectionAccess;
    },
    onChange() {
      return () => {};
    },
  };
  return {
    access,
    change() {
      generation++;
      controller.abort();
      controller = new AbortController();
    },
  };
}

describe("GitHub resource connection boundary", () => {
  it("refuses a retained resource write before dispatch after switching profiles", async () => {
    const scope = boundary();
    let writes = 0;
    const source = "github://example/project/issues/12#body";
    const resolver: ResourceResolver = {
      id: "github",
      async tryResolve() {
        return {
          kind: "resolved",
          resource: {
            source,
            read: async () => [{ type: "text", text: "same text" }],
            write: async () => {
              writes++;
            },
          },
        };
      },
    };
    const result = await fenceGithubResolver(resolver, scope.access).tryResolve(source, {
      cwd: "/project",
    });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved" || !result.resource.write) throw new Error("Missing resource");
    scope.change();
    await expect(
      result.resource.write([{ type: "text", text: "changed" }], {}),
    ).rejects.toMatchObject({
      code: "GH_CONNECTION_CHANGED",
      effect: "not-applied",
    });
    expect(writes).toBe(0);
  });

  it("carries the captured lifetime through the whole resource operation", async () => {
    const scope = boundary();
    const source = "github://example/project/issues/12#body";
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let writes = 0;
    const resolver: ResourceResolver = {
      id: "github",
      async tryResolve() {
        return {
          kind: "resolved",
          resource: {
            source,
            read: async () => [{ type: "text", text: "before" }],
            async write(_content, operation) {
              writes++;
              begin();
              await new Promise<void>((_resolve, reject) => {
                operation.signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("cancelled", "AbortError")),
                  { once: true },
                );
              });
            },
          },
        };
      },
    };
    const result = await fenceGithubResolver(resolver, scope.access).tryResolve(source, {
      cwd: "/project",
    });
    if (result.kind !== "resolved" || !result.resource.write) throw new Error("Missing resource");
    const pending = result.resource
      .write([{ type: "text", text: "one" }], {})
      .catch((error: unknown) => error);
    await started;
    scope.change();
    expect(await pending).toMatchObject({ code: "GH_CONNECTION_CHANGED", effect: "unknown" });
    expect(writes).toBe(1);
  });

  it("keeps a sent save unknown when a switch prevents its verification", async () => {
    const scope = boundary();
    const source = "github://example/project/issues/12#body";
    let writes = 0;
    const methods: string[] = [];
    const client = new GithubClient(
      {
        identity: {
          login: "boundary-fixture",
          name: "Boundary fixture",
          email: "fixture@example.invalid",
        },
        async initialize() {},
        async getToken() {
          return { token: "boundary-fixture-token", expiresAt: Date.now() + 3_600_000 };
        },
      },
      {
        coordinator: new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 }),
        fetcher: async (_input, init) => {
          const method = init?.method ?? "GET";
          methods.push(method);
          if (method === "PATCH") writes++;
          if (method === "GET" && writes > 0) {
            scope.change();
            throw new DOMException("Fixture verification interrupted", "AbortError");
          }
          return Response.json({
            number: 12,
            title: "Fixture",
            body: writes ? "after" : "before",
            updated_at: String(writes),
            html_url: "https://github.com/example/project/issues/12",
          });
        },
      },
    );
    const backend = new GithubBackend(async () => client);
    const result = await fenceGithubResolver(
      createGithubResolver(backend),
      scope.access,
    ).tryResolve(source, { cwd: "/project" });
    if (result.kind !== "resolved" || !result.resource.write) throw new Error("Missing resource");
    await expect(
      result.resource.write([{ type: "text", text: "after" }], {}),
    ).rejects.toMatchObject({ code: "GH_SAVE_UNVERIFIED", effect: "unknown" });
    expect(writes).toBe(1);
    expect(methods).toEqual(["GET", "GET", "PATCH", "GET"]);
  });
  it("does not require a connection for an unrelated local resource", async () => {
    let captures = 0;
    const resolver: ResourceResolver = {
      id: "github",
      async tryResolve() {
        return { kind: "not-handled" };
      },
    };
    const access: GithubConnectionBoundary = {
      async capture() {
        captures++;
        throw new Error("No auth");
      },
      onChange() {
        return () => {};
      },
    };
    expect(
      (await fenceGithubResolver(resolver, access).tryResolve("local.txt", { cwd: "/project" }))
        .kind,
    ).toBe("not-handled");
    expect(captures).toBe(0);
  });
});
