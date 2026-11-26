import { defaultProviderUrl } from "./providers/endpoints.ts";
import type { JsonObject, SearchResultItem, WebsearchConfig } from "./types.ts";

export type SerperEndpoint = "search" | "images" | "lens";
export interface SerperCredentials {
  apiKey: string;
  baseUrl: string;
}
/** One image result as stored for paging: the image itself, its thumbnail and the page that shows it. */
export interface ImageItem {
  title: string;
  imageUrl: string;
  thumbnailUrl?: string;
  pageUrl?: string;
  source?: string;
  width?: number;
  height?: number;
}
export interface SerperPage<T> {
  items: T[];
  credits: number;
}

const MAX_ERROR_LENGTH = 300;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const transport = () =>
  ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-web-search.runtime-transport")] as
    | typeof fetch
    | undefined) ?? globalThis.fetch;

/** Picks the Serper key from the first enabled serper entry, then from SERPER_API_KEY. */
export function serperCredentials(
  config: WebsearchConfig,
  environment: NodeJS.ProcessEnv = process.env,
): SerperCredentials {
  const entry = config.providers.find(
    (provider) => provider.provider === "serper" && provider.enabled !== false && provider.apiKey,
  );
  const apiKey = entry?.apiKey ?? environment.SERPER_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      'Serper is not configured. Add {"provider": "serper", "apiKey": "..."} to websearch.json or set SERPER_API_KEY.',
    );
  return { apiKey, baseUrl: entry?.baseUrl ?? defaultProviderUrl("serper") };
}

function endpointUrl(baseUrl: string, endpoint: SerperEndpoint): string {
  const url = new URL(baseUrl);
  url.pathname = /\/search$/u.test(url.pathname)
    ? url.pathname.replace(/search$/u, endpoint)
    : `${url.pathname.replace(/\/$/u, "")}/${endpoint}`;
  return url.href;
}

function errorDetail(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed) && typeof parsed.message === "string") detail = parsed.message;
  } catch {
    /* the body is not JSON */
  }
  return `Serper request failed with HTTP ${status}${detail ? `: ${detail.slice(0, MAX_ERROR_LENGTH)}` : ""}`;
}

/** Sends one Serper request; a failed request throws the provider's own message and never falls back. */
export async function serperRequest(
  credentials: SerperCredentials,
  endpoint: SerperEndpoint,
  body: JsonObject,
  signal?: AbortSignal,
): Promise<{ payload: JsonObject; credits: number }> {
  const response = await transport()(endpointUrl(credentials.baseUrl, endpoint), {
    method: "POST",
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-KEY": credentials.apiKey,
    },
    body: JSON.stringify(body),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(errorDetail(response.status, bodyText));
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error("Serper returned a response that is not JSON");
  }
  if (!isObject(payload)) throw new Error("Serper returned an unexpected response");
  return { payload, credits: typeof payload.credits === "number" ? payload.credits : 0 };
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Fetches one page of web results; Serper ignores `num`, so paging uses `page`. */
export async function serperWebPage(
  credentials: SerperCredentials,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<SerperPage<SearchResultItem>> {
  const { payload, credits } = await serperRequest(
    credentials,
    "search",
    { q: query, page },
    signal,
  );
  const organic = Array.isArray(payload.organic) ? payload.organic : [];
  const items: SearchResultItem[] = [];
  for (const raw of organic) {
    if (!isObject(raw)) continue;
    const url = text(raw.link);
    if (!url || !isWebUrl(url)) continue;
    const snippet = text(raw.snippet);
    items.push({
      title: text(raw.title) ?? url,
      url,
      ...(snippet && { snippet }),
      ...(text(raw.date) && { publishedAt: text(raw.date) }),
    });
  }
  return { items, credits };
}

function imageItems(raw: unknown[]): ImageItem[] {
  const items: ImageItem[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const imageUrl = text(entry.imageUrl);
    if (!imageUrl || !isWebUrl(imageUrl)) continue;
    const thumbnailUrl = text(entry.thumbnailUrl),
      pageUrl = text(entry.link),
      source = text(entry.source ?? entry.domain),
      width = positiveInteger(entry.imageWidth),
      height = positiveInteger(entry.imageHeight);
    items.push({
      title: text(entry.title) ?? imageUrl,
      imageUrl,
      ...(thumbnailUrl && { thumbnailUrl }),
      ...(pageUrl && { pageUrl }),
      ...(source && { source }),
      ...(width && { width }),
      ...(height && { height }),
    });
  }
  return items;
}

export const IMAGES_PER_CALL = 100;
/** Fetches one page of 100 images (2 credits); `page` selects the next 100. */
export async function serperImagePage(
  credentials: SerperCredentials,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<SerperPage<ImageItem>> {
  const { payload, credits } = await serperRequest(
    credentials,
    "images",
    { q: query, num: IMAGES_PER_CALL, page },
    signal,
  );
  return { items: imageItems(Array.isArray(payload.images) ? payload.images : []), credits };
}

/** Finds pages and images similar to a public image URL (3 credits); one call returns every match. */
export async function serperLens(
  credentials: SerperCredentials,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<SerperPage<ImageItem>> {
  const { payload, credits } = await serperRequest(credentials, "lens", { url: imageUrl }, signal);
  return { items: imageItems(Array.isArray(payload.organic) ? payload.organic : []), credits };
}
