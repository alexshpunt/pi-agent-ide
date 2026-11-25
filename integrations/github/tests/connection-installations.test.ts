import { githubPackageRoot } from "./fixtures/package-root.ts";
import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GithubAppRegistration } from "#github/auth.ts";

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function registration(fetcher: typeof fetch) {
  await mkdir(path.join(githubPackageRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(path.join(githubPackageRoot, ".tmp/app-registration-"));
  directories.push(directory);
  const privateKeyPath = path.join(directory, "app.pem");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  return new GithubAppRegistration(
    { appId: 123, privateKeyPath },
    { coordinator: isolatedCoordinator(), fetcher },
  );
}

describe("user-owned App installation selection", () => {
  it("lists installations with the App signing key before an installation is selected", async () => {
    let calls = 0;
    const app = await registration(async (input, init) => {
      calls++;
      expect(fetchUrl(input)).toBe("https://api.github.com/app/installations?per_page=20&page=1");
      const token = new Headers(init?.headers).get("authorization")?.slice(7);
      expect(token?.split(".")).toHaveLength(3);
      expect(init?.redirect).toBe("error");
      return Response.json([
        {
          id: 456,
          account: { login: "my-org" },
          repository_selection: "selected",
          suspended_at: null,
        },
      ]);
    });
    expect(await app.listInstallations()).toEqual({
      installations: [{ id: 456, account: "my-org", repositories: "selected", suspended: false }],
      hasMore: false,
    });
    expect(calls).toBe(1);
  });
  it("keeps large installation lists explicitly paged", async () => {
    const app = await registration(async (input) => {
      expect(new URL(fetchUrl(input)).searchParams.get("page")).toBe("2");
      return Response.json(
        Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          account: { login: `owner-${index}` },
          repository_selection: "all",
          suspended_at: null,
        })),
      );
    });
    const page = await app.listInstallations(2);
    expect(page.installations).toHaveLength(20);
    expect(page.hasMore).toBe(true);
  });
  it("rejects malformed installations and unbounded page requests", async () => {
    let calls = 0;
    const app = await registration(async () => {
      calls++;
      return Response.json([{ id: -1, account: { login: "bad" } }]);
    });
    await expect(app.listInstallations(0)).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0);
    await expect(app.listInstallations()).rejects.toThrow("installation");
  });
});
