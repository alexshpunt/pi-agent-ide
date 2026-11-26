import type { ImageItem, SerperPage } from "./serper.ts";
import type { SearchResultItem } from "./types.ts";

export const RESOURCE_PREFIX = "websearch:";
const MAX_SESSIONS = 100;

/** Saved results of one search. Each result is one line when read as a resource, so Read offsets count results. */
export interface SearchSession {
  readonly id: string;
  readonly kind: "web" | "images";
  readonly query: string;
  readonly items: Array<SearchResultItem | ImageItem>;
  credits: number;
  /** True once Serper has no further results to give. */
  exhausted: boolean;
  nextPage: number;
  readonly fetchPage: (
    page: number,
    signal?: AbortSignal,
  ) => Promise<SerperPage<SearchResultItem | ImageItem>>;
  /** Serialises fetches so concurrent reads never pay for the same page twice. */
  queue: Promise<unknown>;
  /** Lens answers in one call; later pages do not exist. */
  readonly singlePage: boolean;
}

const sessions = new Map<string, SearchSession>();

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}
const sizeOf = (item: ImageItem): string | undefined =>
  item.width && item.height ? `${item.width}x${item.height}` : undefined;
const isImage = (item: SearchResultItem | ImageItem): item is ImageItem => "imageUrl" in item;

/** One result as one line. Fields are separated by " | " and labeled where they are optional. */
export function resultLine(index: number, item: SearchResultItem | ImageItem): string {
  if (isImage(item)) {
    const parts = [`${index}. ${oneLine(item.title)}`, `image: ${item.imageUrl}`];
    if (item.thumbnailUrl) parts.push(`thumbnail: ${item.thumbnailUrl}`);
    if (item.pageUrl) parts.push(`page: ${item.pageUrl}`);
    const size = sizeOf(item);
    if (size) parts.push(`size: ${size}`);
    if (item.source) parts.push(`source: ${oneLine(item.source)}`);
    return parts.join(" | ");
  }
  const parts = [`${index}. ${oneLine(item.title)}`, item.url];
  const snippet = oneLine(item.snippet);
  if (snippet) parts.push(snippet);
  return parts.join(" | ");
}

function uniqueId(base: string): string {
  const cleaned =
    base
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "search";
  if (!sessions.has(cleaned)) return cleaned;
  for (let suffix = 2; ; suffix++)
    if (!sessions.has(`${cleaned}-${suffix}`)) return `${cleaned}-${suffix}`;
}

/** Creates an empty session. The id comes from the tool call, so a replayed call finds the same resource. */
export function createSession(
  input: Pick<SearchSession, "kind" | "query" | "fetchPage"> & {
    callId: string;
    singlePage?: boolean;
  },
): SearchSession {
  const session: SearchSession = {
    id: uniqueId(input.callId),
    kind: input.kind,
    query: input.query,
    items: [],
    credits: 0,
    exhausted: false,
    nextPage: 1,
    fetchPage: input.fetchPage,
    queue: Promise.resolve(),
    singlePage: input.singlePage ?? false,
  };
  sessions.set(session.id, session);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
  return session;
}

export function findSession(id: string): SearchSession | undefined {
  return sessions.get(id);
}
export function resourceSource(session: SearchSession): string {
  return `${RESOURCE_PREFIX}${session.id}`;
}
export function sessionIdOf(source: string): string | undefined {
  return source.startsWith(RESOURCE_PREFIX) ? source.slice(RESOURCE_PREFIX.length) : undefined;
}
export function clearSessions(): void {
  sessions.clear();
}

/** Fetches pages until `count` results are saved or Serper has no more. Never fetches a page it already has. */
export function ensureResults(
  session: SearchSession,
  count: number,
  signal?: AbortSignal,
): Promise<void> {
  const run = async (): Promise<void> => {
    const seen = new Set(session.items.map((item) => (isImage(item) ? item.imageUrl : item.url)));
    while (session.items.length < count && !session.exhausted) {
      signal?.throwIfAborted();
      const page = await session.fetchPage(session.nextPage, signal);
      session.nextPage++;
      session.credits += page.credits;
      let added = 0;
      for (const item of page.items) {
        const key = isImage(item) ? item.imageUrl : item.url;
        if (seen.has(key)) continue;
        seen.add(key);
        session.items.push(item);
        added++;
      }
      if (added === 0 || session.singlePage) session.exhausted = true;
    }
  };
  const result = session.queue.then(run, run);
  session.queue = result.catch(() => undefined);
  return result;
}
