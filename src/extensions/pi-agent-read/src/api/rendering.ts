export type ReadPresentationKind = "code-view" | "markdown" | "source";

export interface ReadResultRendererOptions
{
    readonly kind: ReadPresentationKind;
    readonly label?: string;
}

export { createReadResultRenderer } from "#src/core/tools/read/read-renderer.js";

export type { ReadResultRenderer } from "#src/api/tools/read.js";
