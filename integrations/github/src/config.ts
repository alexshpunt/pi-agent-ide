import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseAppConfig, type AppConfig } from "./auth.ts";
import { assertWindowsPrivateFile } from "./windows-private-path.ts";

/** Read the existing PiClanker settings without changing shell routing or credentials.
 * PI_CLANKER_CONFIG overrides ~/.config/pi-clanker/config.json. A relative override
 * resolves from cwd, matching the shell's existing configuration behavior.
 */
export async function loadGithubConfig(cwd: string): Promise<AppConfig> {
  const selected = process.env.PI_CLANKER_CONFIG;
  const configPath =
    selected === undefined
      ? path.join(homedir(), ".config", "pi-clanker", "config.json")
      : path.resolve(cwd, selected);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let contents: unknown;
  try {
    if (selected !== undefined && !selected.trim()) throw new Error("empty config path");
    file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))
    ) {
      throw new Error("unsafe config");
    }
    await assertWindowsPrivateFile(configPath, stat);
    contents = JSON.parse(await file.readFile("utf8"));
  } catch {
    throw new Error(
      "GitHub App configuration could not be read safely. Set up PiClanker or select PI_CLANKER_CONFIG.",
    );
  } finally {
    await file?.close();
  }
  return parseAppConfig(contents);
}
