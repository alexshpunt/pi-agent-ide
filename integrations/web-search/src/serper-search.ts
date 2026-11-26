import { publicImageUrl, type PublicImage } from "./image-source.ts";
import { resultsResourceAvailable } from "./read-plugin.ts";
import {
  createSession,
  ensureResults,
  resourceSource,
  resultLine,
  type SearchSession,
} from "./result-store.ts";
import { formatSearchText } from "./search-format.ts";
import {
  IMAGES_PER_CALL,
  serperCredentials,
  serperImagePage,
  serperLens,
  serperWebPage,
  type ImageItem,
} from "./serper.ts";
import type { SearchDetails, WebsearchConfig } from "./types.ts";

export const DEFAULT_RESULT_COUNT = 10;
export interface ImageSearchDetails {
  kind: "text" | "lens";
  query: string;
  image?: string;
  results: ImageItem[];
  total: number;
  exhausted: boolean;
  credits: number;
  resource?: string;
}

function footer(session: SearchSession, shown: number): string {
  if (!resultsResourceAvailable()) return `Serper credits used: ${session.credits}.`;
  const source = resourceSource(session);
  const more =
    session.exhausted && shown >= session.items.length
      ? "Serper has no further results."
      : `Read ${source} with offset ${shown + 1} and a limit for more results${session.singlePage ? "" : "; a Read past the saved results fetches the next Serper page"}.`;
  return `Saved as ${source}: one line per result. ${more} Search ${source} finds text or URLs in the saved results. Serper credits used: ${session.credits}.`;
}

/** Searches the web through Serper only. A Serper failure is thrown with Serper's own message. */
export async function serperWebSearch(
  config: WebsearchConfig,
  input: { query: string; limit: number; callId: string },
  signal?: AbortSignal,
): Promise<SearchDetails> {
  const started = Date.now();
  const credentials = serperCredentials(config);
  const session = createSession({
    kind: "web",
    query: input.query,
    callId: input.callId,
    fetchPage: (page, pageSignal) => serperWebPage(credentials, input.query, page, pageSignal),
  });
  await ensureResults(session, input.limit, signal);
  const results = session.items.slice(0, input.limit) as SearchDetails["results"];
  const durationMs = Date.now() - started;
  return {
    provider: "serper",
    query: input.query,
    results,
    durationMs,
    truncated: session.items.length > results.length || !session.exhausted,
    attempts: [
      {
        provider: "serper",
        durationMs,
        resultsCount: results.length,
        status: results.length ? "success" : "empty",
      },
    ],
    ...(resultsResourceAvailable() && { resource: resourceSource(session) }),
    credits: session.credits,
    note: footer(session, results.length),
  };
}

export function formatWebSearch(details: SearchDetails): string {
  const body = details.results.length
    ? formatSearchText(details)
    : "Serper returned no results for this query.";
  return details.note ? `${body}\n\n${details.note}` : body;
}

/** Searches images by text, or finds similar images for a public URL or a local image file. */
export async function serperImageSearch(
  config: WebsearchConfig,
  input: { query?: string; image?: string; limit: number; callId: string; cwd: string },
  signal?: AbortSignal,
): Promise<{ text: string; details: ImageSearchDetails }> {
  const query = input.query?.trim(),
    image = input.image?.trim();
  if (!query === !image)
    throw new Error(
      "Give exactly one of query (a text search) or image (an image URL or a local image file).",
    );
  const credentials = serperCredentials(config);
  let note = "";
  let session: SearchSession;
  let uploaded: PublicImage | undefined;
  try {
    if (query) {
      session = createSession({
        kind: "images",
        query,
        callId: input.callId,
        fetchPage: (page, pageSignal) => serperImagePage(credentials, query, page, pageSignal),
      });
    } else {
      uploaded = await publicImageUrl(image!, input.cwd, signal, config.catboxUserhash);
      const url = uploaded.url;
      if (url !== image)
        note = uploaded.remove
          ? `Uploaded ${image} to your Catbox account for this search only: ${url}\n`
          : `Uploaded ${image} to a temporary file host (deleted after 1 hour): ${url}\n`;
      session = createSession({
        kind: "images",
        query: url,
        callId: input.callId,
        singlePage: true,
        fetchPage: (page, pageSignal) => serperLens(credentials, url, pageSignal),
      });
    }
    await ensureResults(session, Math.min(input.limit, IMAGES_PER_CALL), signal);
  } finally {
    const warning = await uploaded?.remove?.();
    if (warning) note += `${warning}\n`;
  }
  const results = session.items.slice(0, input.limit) as ImageItem[];
  const details: ImageSearchDetails = {
    kind: query ? "text" : "lens",
    query: session.query,
    ...(image && { image }),
    results,
    total: session.items.length,
    exhausted: session.exhausted,
    credits: session.credits,
    ...(resultsResourceAvailable() && { resource: resourceSource(session) }),
  };
  const heading = query
    ? `Images for "${query}":`
    : `Images and pages similar to ${session.query}:`;
  const lines = results.length
    ? results.map((item, index) => resultLine(index + 1, item)).join("\n")
    : "Serper returned no images.";
  return { text: `${note}${heading}\n${lines}\n\n${footer(session, results.length)}`, details };
}
