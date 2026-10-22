import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "./content.js";

const event = "pi-agent-resource:result-images";
/** Base64 characters of images kept for later writes; the oldest results drop out first. */
const keptImageSize = 64 * 1024 * 1024;

/**
 * Keeps the images of issued results so Write can save them by result reference.
 * Separate from ResultTargetStore, which another extension's older copy can own.
 */
export class ResultImageStore {
  readonly #results = new Map<string, { cwd: string; images: readonly ImageContent[] }>();
  #size = 0;

  /** Forget results when the session closes or the extensions reload. */
  public clear(): void {
    this.#results.clear();
    this.#size = 0;
  }

  /** Record an issued result by its displayed envelope, with its images or none. */
  public keep(shown: string, cwd: string, images: readonly ImageContent[]): void {
    const id = /^<system-result\b[^>]*><uuid>([a-f\d-]{36})<\/uuid>/u.exec(shown)?.[1];
    if (id === undefined) return;
    this.#results.set(id, { cwd: path.resolve(cwd), images });
    this.#size += imageSize(images);
    for (const [kept, result] of this.#results) {
      if (this.#size <= keptImageSize || kept === id) break;
      if (result.images.length === 0) continue;
      this.#results.set(kept, { ...result, images: [] });
      this.#size -= imageSize(result.images);
    }
  }

  /**
   * Return the images of an issued result named exactly by its UUID or RESULT# reference.
   * Any other text is not a reference and returns undefined.
   */
  public images(input: string, cwd: string): readonly ImageContent[] | undefined {
    const id = /^(?:RESULT#)?([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/u.exec(
      input,
    )?.[1];
    const result = id === undefined ? undefined : this.#results.get(id);
    if (result === undefined) return undefined;
    if (result.cwd !== path.resolve(cwd)) throw new Error("Result belongs to another worktree.");
    if (result.images.length === 0)
      throw new Error(
        "This result has no kept images. Read the image again and pass the new result.",
      );
    return result.images;
  }
}

function imageSize(images: readonly ImageContent[]): number {
  return images.reduce((size, image) => size + image.data.length, 0);
}

/** Share one image store through Pi's extension event bus, without process-global state. */
export function connectResultImages(pi: ExtensionAPI): ResultImageStore {
  let existing: ResultImageStore | undefined;
  pi.events.emit(event, {
    accept: (store: ResultImageStore) => {
      existing = store;
    },
  });
  if (existing !== undefined) return existing;
  const store = new ResultImageStore();
  const unsubscribe = pi.events.on(event, (request) => {
    if (
      request !== null &&
      typeof request === "object" &&
      "accept" in request &&
      typeof request.accept === "function"
    )
      (request.accept as (store: ResultImageStore) => void)(store);
  });
  pi.on("session_start", () => {
    store.clear();
  });
  pi.on("session_shutdown", () => {
    store.clear();
    unsubscribe();
  });
  return store;
}
