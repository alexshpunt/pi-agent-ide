export type { AgentContent, AgentContentBlock, CustomContent, ImageContent, TextContent } from "./content.js";

export type {
    ContentCapability,
    ContentConversionAttempt,
    ContentConversionContext,
    ContentConverter,
    ContentConverterRegistration,
    ContentDescription,
    ContentInput,
    ContentTarget,
} from "./content-conversion/content-converter.js";

export { renderContentDescription } from "./content-conversion/content-description.js";

export { type ContentHost, createContentHost } from "./content-conversion/content-host.js";

export {
    type ContentRunner,
    createContentRunner,
    targetsEqual,
    UnsupportedContentError,
} from "./content-conversion/content-runner.js";

export { connectContentConverter } from "./content-conversion/connect-plugin.js";

export {
    CONTENT_API_VERSION,
    CONTENT_CONVERTER_REGISTER_EVENT,
    CONTENT_HOST_READY_EVENT,
    CONTENT_PROTOCOL,
    type ContentConverterRegistrationRequest,
    type ContentHostReady,
    isContentConverterRegistrationRequest,
    isContentHostReady,
} from "./content-conversion/plugin-protocol.js";

export {
    isContentConversionAttempt,
    isContentConversionContext,
    isContentConverter,
    isContentConverterRegistration,
    isContentInput,
    isContentTarget,
} from "./content-conversion/validation.js";

export type {
    ReadableResource,
    ReadWriteResource,
    Resource,
    ResourceBase,
    ResourceOperationContext,
    ResourceRead,
    ResourceWrite,
    WritableResource,
} from "./resource.js";

export type {
    ResourceResolutionAttempt,
    ResourceResolver,
    ResourceResolverContext,
    ResourceTryResolve,
} from "./resolver.js";

export { isAgentContent, isResource, isResourceResolutionAttempt, isResourceResolver } from "./validation.js";
