import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Provision the pinned Java bridge in an isolated directory. Requires a JDK 21 JAVA_HOME.
const directory = path.resolve(process.argv[2] ?? ".tmp/java-debugger");
if (!["linux", "win32"].includes(process.platform))
  throw new Error("Java lifecycle checks require Linux or native Windows");
if (!process.env.JAVA_HOME) throw new Error("Set JAVA_HOME to a JDK 21 installation");
await mkdir(directory, { recursive: true });
let tar = "tar";
if (process.platform === "win32") {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows provisioning requires SystemRoot");
  // Git Bash also ships GNU tar, which treats Windows drive paths as remote hosts.
  tar = path.join(systemRoot, "System32", "tar.exe");
}
const archives = [
  {
    file: "jdtls.tar.gz",
    url: "https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz",
    sha256: "338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64",
    target: "jdtls",
  },
  {
    file: "debug.vsix",
    url: "https://open-vsx.org/api/vscjava/vscode-java-debug/0.59.0/file/vscjava.vscode-java-debug-0.59.0.vsix",
    sha256: "87627e24dbb5b01137decc0265f043cb08adad22af3c195f1ba39898dafb1588",
    target: "debug",
  },
];
for (const archive of archives) {
  const filename = path.join(directory, archive.file);
  let bytes: Buffer;
  try {
    bytes = await readFile(filename);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const response = await fetch(archive.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok)
      throw new Error(`Download failed: ${archive.url}: ${response.status}`, { cause: error });
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(filename, bytes);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256)
    throw new Error(`Checksum mismatch: ${filename}`);
  const target = path.join(directory, archive.target);
  await mkdir(target, { recursive: true });
  if (archive.file.endsWith(".vsix") && process.platform !== "win32")
    execFileSync("unzip", ["-q", "-o", filename, "-d", target], { stdio: "inherit" });
  else execFileSync(tar, ["-xf", filename, "-C", target], { stdio: "inherit" });
}
const suffix = process.platform === "win32" ? ".exe" : "";
const environment = {
  PI_JAVA_PATH: path.join(process.env.JAVA_HOME, "bin", `java${suffix}`),
  PI_JAVAC_PATH: path.join(process.env.JAVA_HOME, "bin", `javac${suffix}`),
  PI_JDTLS_HOME: path.join(directory, "jdtls"),
  PI_JAVA_DEBUG_PLUGIN_PATH: path.join(
    directory,
    "debug/extension/server/com.microsoft.java.debug.plugin-0.53.2.jar",
  ),
  PI_DEBUGGER_JVM_LANGUAGE: "java",
};
if (process.env.GITHUB_ENV)
  await appendFile(
    process.env.GITHUB_ENV,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
console.log(JSON.stringify(environment, null, 2));
