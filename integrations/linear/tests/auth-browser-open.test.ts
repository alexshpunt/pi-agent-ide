import { expect, test, vi } from "vitest";
import { openAuthorizationPage } from "#linear/auth-browser.ts";

const url = "https://mcp.linear.app/authorize?client_id=public&state=fixture&scope=read%2Cwrite";

test.each([
  ["linux", "xdg-open", [url]],
  ["darwin", "open", [url]],
  ["win32", "rundll32", ["url.dll,FileProtocolHandler", url]],
] as const)(
  "opens the authorization page with the default %s browser without a shell",
  async (platform, command, args) => {
    const launch = vi.fn(async () => {});
    await expect(openAuthorizationPage(url, launch, platform)).resolves.toBe(true);
    expect(launch).toHaveBeenCalledExactlyOnceWith(command, [...args]);
  },
);

test("a missing browser launcher leaves manual completion available", async () => {
  const launch = vi.fn(async () => {
    throw new Error("synthetic private launcher failure");
  });
  await expect(openAuthorizationPage(url, launch, "linux")).resolves.toBe(false);
});

test.each([
  "https://example.test/authorize",
  "https://mcp.linear.app/authorize?access_token=private",
  "https://linear.app/oauth/authorize?code=private",
  "file:///tmp/authorization.html",
  "https://linear.app/oauth/authorize#private",
])("never launches an unvalidated authorization target: %s", async (target) => {
  const launch = vi.fn(async () => {});
  await expect(openAuthorizationPage(target, launch, "linux")).rejects.toThrow(
    "LINEAR_AUTH_INVALID_RESPONSE",
  );
  expect(launch).not.toHaveBeenCalled();
});
