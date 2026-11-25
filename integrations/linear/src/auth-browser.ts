import { execFile } from "node:child_process";

/** Only the two supported Linear consent endpoints may reach a browser launcher. */
export function authorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_000)
    throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
  }
  if (
    url.protocol !== "https:" ||
    !(
      (url.hostname === "linear.app" && url.pathname === "/oauth/authorize") ||
      (url.hostname === "mcp.linear.app" && url.pathname === "/authorize")
    ) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      ["access_token", "refresh_token", "client_secret", "token", "code"].includes(key),
    )
  )
    throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
  return url.href;
}

type BrowserLauncher = (command: string, args: string[]) => Promise<void>;
const launchBrowser: BrowserLauncher = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 4_096, windowsHide: true }, (error) => {
      if (error) reject(new Error("LINEAR_AUTH_BROWSER_UNAVAILABLE"));
      else resolve();
    });
  });

/** A launch failure is recoverable through the separately displayed manual link. Never use a shell. */
export async function openAuthorizationPage(
  value: string,
  launch: BrowserLauncher = launchBrowser,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const url = authorizationUrl(value);
  const [command, args]: [string, string[]] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    await launch(command, args);
    return true;
  } catch {
    return false;
  }
}
