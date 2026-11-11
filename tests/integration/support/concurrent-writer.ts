/**
 * A peer session that keeps writing a file in the Pi workspace, like another agent editing it.
 *
 * The peer is a separate process, started from inside the running Pi with the `bash` tool, so it
 * writes the workspace the tools work in and keeps writing while a tool call runs. A writer
 * started in the test process cannot do that: the test's own event loop stalls while Pi runs.
 *
 * Every write inserts one numbered line at the top of the file through a temporary file and a
 * rename, as an editor saving a file does. Existing lines keep their text; only their numbers
 * move, and edits other sessions made meanwhile are kept, because each write reads the file
 * first.
 *
 * Shared by the concurrent-writer stress tests of `search`, `ast_search` and `lsp_search`
 * (LPT-1382 owns it; ask there for what a reusing test needs).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ConcurrentWriterOptions {
  /** Workspace-relative file the peer keeps writing. */
  readonly file: string;
  /** Milliseconds between two writes. Default 150. */
  readonly intervalMs?: number;
  /** Line inserted at the top, followed by the number of the write. Default `// peer`. */
  readonly marker?: string;
  /** The peer stops by itself after this long, so no run leaks a process. Default 120 s. */
  readonly lifetimeMs?: number;
  /** Workspace-relative script path. Default `peer-writer.mjs`. */
  readonly script?: string;
}

export interface ConcurrentWriter {
  /** Bash command that starts the peer; run it with `background: true`. */
  readonly command: string;
  /** Terminal session name to give that `bash` call, and to delete when the rounds are done. */
  readonly session: string;
  /** Writes the peer has finished, read from its progress file. */
  writes(): Promise<number>;
}

/**
 * Writes the peer script into the workspace and returns how to start and stop it. Call it before
 * the Pi run, and start the peer inside the run.
 */
export async function installConcurrentWriter(
  cwd: string,
  options: ConcurrentWriterOptions,
): Promise<ConcurrentWriter> {
  const script = options.script ?? "peer-writer.mjs";
  const progress = `${script}.writes`;
  const settings = {
    file: options.file,
    intervalMs: options.intervalMs ?? 150,
    marker: options.marker ?? "// peer",
    lifetimeMs: options.lifetimeMs ?? 120_000,
    progress,
  };
  await writeFile(path.join(cwd, script), peerScript(settings), "utf8");
  return {
    command: `node ${script}`,
    session: "peer-writer",
    async writes() {
      try {
        return Number.parseInt(await readFile(path.join(cwd, progress), "utf8"), 10) || 0;
      } catch {
        return 0;
      }
    },
  };
}

function peerScript(settings: {
  readonly file: string;
  readonly intervalMs: number;
  readonly marker: string;
  readonly lifetimeMs: number;
  readonly progress: string;
}): string {
  return `import { readFile, rename, writeFile } from "node:fs/promises";

const settings = ${JSON.stringify(settings, undefined, 2)};
const deadline = Date.now() + settings.lifetimeMs;
let writes = 0;

while (Date.now() < deadline) {
  try {
    // Read first, so edits another session made since the last write are kept.
    const content = await readFile(settings.file, "utf8");
    const temporary = settings.file + ".peer";
    await writeFile(temporary, settings.marker + " " + String(writes + 1) + "\\n" + content);
    await rename(temporary, settings.file);
    writes += 1;
    await writeFile(settings.progress, String(writes));
  } catch (error) {
    // The file may be missing for an instant while another session replaces it.
    if (error?.code !== "ENOENT") throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, settings.intervalMs));
}
`;
}

export interface ConcurrentWriterSourceOptions {
  /** Lines of filler code around the markers. Default 3000. */
  readonly lines?: number;
  /** Identifier every whole-result round renames. Default `alpha_token_0`. */
  readonly token?: string;
  /** Numbered comment markers, one per numbered-anchor round. Default 40. */
  readonly markers?: number;
}

export interface ConcurrentWriterSource {
  readonly content: string;
  /** Identifier of the whole-result rounds and how many times it occurs. */
  readonly token: string;
  readonly tokenOccurrences: number;
  /** Numbered markers `beta_0001`…, one match each, and how many there are. */
  readonly markerQuery: string;
  readonly markers: number;
}

/**
 * A large C++ source with repeated matches, valid before and after the edits the stress tests
 * make: the renamed identifier is renamed everywhere, and the numbered markers are comments.
 */
export function createConcurrentWriterSource(
  options: ConcurrentWriterSourceOptions = {},
): ConcurrentWriterSource {
  const token = options.token ?? "alpha_token_0";
  const markers = options.markers ?? 40;
  const lines = options.lines ?? 3000;
  const rows = [
    "#include <cstdint>",
    "",
    "namespace peer {",
    "",
    "int compute(int value) { return value * 2; }",
    "",
    `int ${token}(int value) { return value + 1; }`,
    "",
    "int body() {",
    "  int total = 0;",
  ];
  const calls = 5;
  const filler = Math.max(lines - rows.length - markers - calls - 4, 0);
  const callEvery = Math.max(Math.floor(filler / (calls + 1)), 1);
  let placed = 0;
  for (let index = 1; index <= filler; index += 1) {
    rows.push(`  total += compute(${String(index)});`);
    if (index % callEvery === 0 && placed < calls) {
      rows.push(`  total += ${token}(${String(index)});`);
      placed += 1;
    }
  }
  while (placed < calls) {
    rows.push(`  total += ${token}(0);`);
    placed += 1;
  }
  for (let index = 1; index <= markers; index += 1)
    rows.push(`  // beta_${String(index).padStart(4, "0")} keep`);
  rows.push("  return total;", "}", "", "}", "");
  return {
    content: rows.join("\n"),
    token,
    tokenOccurrences: rows.filter((row) => row.includes(token)).length,
    markerQuery: String.raw`regex:beta_\d{4}`,
    markers,
  };
}
