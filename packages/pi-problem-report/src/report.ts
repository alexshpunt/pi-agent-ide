import { homedir } from "node:os";

import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** GitHub rejects longer new-issue links; long stacks lose their last frames first. */
export const MAX_ISSUE_URL_LENGTH = 7000;
const MAX_STACK_LINES = 15;
const MAX_TITLE_WIDTH = 100;

/** The extension a problem is reported to. */
export interface ProblemSource {
  readonly name: string;
  readonly version: string;
  /** Issue tracker, for example `https://github.com/alexshpunt/pi-agent-ide/issues`. */
  readonly issuesUrl: string;
}

/** Something that went wrong in an extension: an unexpected error or a state it cannot handle. */
export interface Problem {
  /** What happened, in a few words, for the user. */
  readonly summary: string;
  readonly error?: unknown;
  /** What the user can expect now; shown under the error in the panel. */
  readonly consequence?: string;
  /** Extra report lines, such as the module or tool involved. */
  readonly context?: readonly string[];
  /** Identity for de-duplication; defaults to the summary and the error message. */
  readonly key?: string;
}

export interface ProblemReport {
  title: string;
  /** Issue body with the error, its stack, context and versions. */
  body: string;
  /** New-issue link with the title and body filled in. */
  url: string;
}

/** Message of an error or other thrown value; empty when nothing was thrown. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error === undefined) return "";
  if (typeof error === "string") return error;
  // Errors from another realm, such as a worker or a VM context, fail instanceof.
  if (typeof error === "object" && error !== null && "message" in error) {
    if (typeof error.message === "string") return error.message;
  }
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  )
    return String(error);
  if (typeof error === "function") return "function";
  try {
    return JSON.stringify(error);
  } catch {
    return typeof error;
  }
}

/** Stable identity of a problem for de-duplication. */
export function problemKey(problem: Problem): string {
  return problem.key ?? `${problem.summary}\n${errorMessage(problem.error)}`;
}

/** Pi's version, whether it is the Pi-Bolt build, the runtime and the platform. */
function hostDescription(): string {
  const bolt = /pi-bolt/iu.test(process.execPath) ? " (Pi-Bolt)" : "";
  const runtime =
    process.versions.bun === undefined
      ? `Node.js ${process.versions.node}`
      : `Bun ${process.versions.bun}`;
  return `Pi ${VERSION}${bolt}, ${runtime}, ${process.platform}-${process.arch}`;
}

/** Replace the user's home folder, which appears in every installed extension path. */
function withoutHome(text: string): string {
  const home = homedir();
  return home ? text.replaceAll(home, "~") : text;
}

function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || !error.stack) return [];
  const lines = error.stack.split("\n");
  // The stack starts with the message, which may span several lines; the report shows it already.
  const first = lines.findIndex((line) => /^\s+at\s/u.test(line));
  return lines
    .slice(first === -1 ? 1 : first)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(withoutHome)
    .slice(0, MAX_STACK_LINES);
}

/** Build the issue a user can review and submit; nothing is sent automatically. */
export function problemReport(source: ProblemSource, problem: Problem): ProblemReport {
  const message = withoutHome(errorMessage(problem.error));
  const title = truncateToWidth(message || problem.summary, MAX_TITLE_WIDTH, "…");
  const frames = stackFrames(problem.error);
  const context = (problem.context ?? []).map(withoutHome);
  const body = (lines: readonly string[], text = message): string =>
    [
      "### What happened",
      problem.summary,
      "",
      ...(text ? ["### Error", "```text", text, ...lines, "```", ""] : []),
      ...(context.length > 0 ? ["### Context", ...context.map((line) => `- ${line}`), ""] : []),
      "### Environment",
      `- ${source.name} ${source.version}`,
      `- ${hostDescription()}`,
      "",
      "### What I was doing",
      "<!-- For example: the tool call or command that was running. -->",
      "",
    ].join("\n");
  const base = source.issuesUrl.replace(/\/+$/u, "");
  const link = (text: string): string =>
    `${base}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
  let shown = frames;
  while (shown.length > 0 && link(body(shown)).length > MAX_ISSUE_URL_LENGTH)
    shown = shown.slice(0, -1);
  // Without frames, a long message is shortened too; the copied report keeps it whole.
  // Whole characters, so a cut never leaves half a surrogate pair, which encodeURIComponent rejects.
  const characters = Array.from(new Intl.Segmenter().segment(message), (part) => part.segment);
  let kept = characters.length;
  const shortened = (): string =>
    kept < characters.length ? `${characters.slice(0, kept).join("")}…` : message;
  while (kept > 0 && link(body(shown, shortened())).length > MAX_ISSUE_URL_LENGTH)
    kept = Math.floor(kept * 0.8);
  return { title, body: body(frames), url: link(body(shown, shortened())) };
}
