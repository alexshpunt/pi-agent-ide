import type { AgentContent } from "./content.js";

export interface ResourceOperationContext {
  readonly signal?: AbortSignal;
}

export type ResourceRead = (context: ResourceOperationContext) => Promise<AgentContent>;

/** An original byte window, with absolute byte coordinates and the file's total length. */
export interface ResourceByteRange {
  readonly bytes: Uint8Array;
  readonly byteOffset: number;
  readonly totalBytes: number;
}

/** Read original bytes; clamp EOF-relative offsets, omit limit for the remainder, zero for none. */
export type ResourceByteRead = (
  offset: number,
  limit: number | undefined,
  context: ResourceOperationContext,
) => Promise<ResourceByteRange>;

/**
 * Persist content. A rejection with `effect: "not-applied"` guarantees this call made
 * no stored change, so consumers can skip compensating this rejected resource.
 * Other rejections do not guarantee that persistence was avoided.
 */
export type ResourceWrite = (
  content: AgentContent,
  context: ResourceOperationContext,
) => Promise<void>;

export interface ResourceBase {
  readonly source: string;
  readonly link?: string;
  /** Original file bytes captured by the most recent read, before conversion. Never set for listings or generated content. Consumers must not mutate this snapshot. */
  readonly sourceBytes?: Uint8Array;
  /** Optional original-byte access, without content conversion or text annotations. */
  readonly readBytes?: ResourceByteRead;
  /** Skip document post-edit processing for stateful resources such as terminals. */
  readonly skipPostEdit?: boolean;
}

export interface ReadableResource extends ResourceBase {
  readonly read: ResourceRead;
  readonly write?: never;
}

export interface WritableResource extends ResourceBase {
  readonly read?: never;
  readonly write: ResourceWrite;
}

export interface ReadWriteResource extends ResourceBase {
  readonly read: ResourceRead;
  readonly write: ResourceWrite;
}

export type Resource = ReadableResource | WritableResource | ReadWriteResource;
