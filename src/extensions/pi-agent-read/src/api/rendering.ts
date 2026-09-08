export type ReadPresentationKind = "code-view" | "markdown" | "source";

export interface ReadResultRendererOptions {
  readonly kind: ReadPresentationKind;
  readonly label?: string;

  /** Opt local-file results into Pi's special skill, docs, and context-file presentation. */
  readonly nativeResources?: boolean;
}

export { createReadResultRenderer } from "#src/core/tools/read/read-renderer.js";

export type { ReadResultRenderer } from "#src/api/tools/read.js";
