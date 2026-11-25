import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Replace only the OS browser executable, not the production launcher or URL validation.
export async function browserLauncherEnvironment(cwd: string) {
  if (process.platform === "win32")
    throw new Error("This browser fixture needs a POSIX executable");
  const bin = path.join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  const opener = path.join(bin, process.platform === "darwin" ? "open" : "xdg-open");
  await writeFile(
    opener,
    `#!${process.execPath}\nimport("node:fs").then(fs => fs.writeFileSync(${JSON.stringify(path.join(cwd, "browser-opened.json"))}, JSON.stringify(process.argv.slice(2))));\n`,
    { mode: 0o700 },
  );
  return { PATH: bin + path.delimiter + (process.env.PATH ?? "") };
}
