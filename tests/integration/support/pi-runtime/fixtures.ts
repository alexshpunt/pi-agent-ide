import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const sandboxRoot = path.join(process.cwd(), ".agents/sandbox");

export async function withTempWorkspace<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  await mkdir(sandboxRoot, { recursive: true });
  const directory = await mkdtemp(path.join(sandboxRoot, "text-anchor-integration-workspace-"));

  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createFixture(
  directory: string,
  name: string,
  content: string,
): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, content, "utf8");
  return file;
}
