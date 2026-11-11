export { ResourceScheduler, resourceScheduler, type ResourceAccess } from "./resource-scheduler.ts";
export { resourceAccesses } from "./resource-access.ts";
export { TempResourceStore, type TempResourceStoreOptions } from "./temp-resource-store.ts";
export {
  assertJsonData,
  MAX_STRUCTURED_BYTES,
  resultError,
  resultErrorSchema,
  structuredResultSchema,
  withStructuredResult,
  type ResultError,
  type StructuredResult,
} from "./tool-result.ts";
export { ResourceError } from "./resource-error.ts";
export {
  resourceErrorMetadata,
  resourceErrorMetadataOf,
  resourceErrorMetadataSchema,
  type ResourceErrorMetadata,
  type ResourceRateLimit,
} from "./resource-error-metadata.ts";
export type {
  AgentContent,
  AgentContentBlock,
  CustomContent,
  ImageContent,
  TextContent,
} from "./content.ts";

export type {
  ContentCapability,
  ContentConversionAttempt,
  ContentConversionContext,
  ContentConverter,
  ContentConverterRegistration,
  ContentDescription,
  ContentInput,
  ContentTarget,
} from "./content-conversion/content-converter.ts";

export { renderContentDescription } from "./content-conversion/content-description.ts";

export { type ContentHost, createContentHost } from "./content-conversion/content-host.ts";

export {
  type ContentRunner,
  createContentRunner,
  targetsEqual,
  UnsupportedContentError,
} from "./content-conversion/content-runner.ts";

export { connectContentConverter } from "./content-conversion/connect-plugin.ts";

export {
  CONTENT_API_VERSION,
  CONTENT_CONVERTER_REGISTER_EVENT,
  CONTENT_HOST_READY_EVENT,
  CONTENT_PROTOCOL,
  type ContentConverterRegistrationRequest,
  type ContentHostReady,
  isContentConverterRegistrationRequest,
  isContentHostReady,
} from "./content-conversion/plugin-protocol.ts";

export {
  isContentConversionAttempt,
  isContentConversionContext,
  isContentConverter,
  isContentConverterRegistration,
  isContentInput,
  isContentTarget,
} from "./content-conversion/validation.ts";

export type {
  ReadableResource,
  ReadWriteResource,
  Resource,
  ResourceBase,
  ResourceByteRead,
  ResourceByteRange,
  ResourceOperationContext,
  ResourceRead,
  ResourceWrite,
  WritableResource,
} from "./resource.ts";

export type {
  ResourceResolutionAttempt,
  ResourceResolver,
  ResourceResolverContext,
  ResourceTryResolve,
} from "./resolver.ts";

export {
  isAgentContent,
  isResource,
  isResourceResolutionAttempt,
  isResourceResolver,
} from "./validation.ts";

export {
  connectResultTargets,
  verifyResultTargets,
  currentResultTargets,
  resultTargetsInText,
  describeAdjustedRanges,
  ResultTargetStore,
  resultInputSchema,
  type ResultRange,
  type ResultSourceTarget,
  type ResolvedResultTargets,
} from "./result-targets.ts";
export { connectResultImages, ResultImageStore } from "./result-images.ts";
export { createLineMap, rangesInText, rebaseOrRelocateRange, type LineMap } from "./line-map.ts";
