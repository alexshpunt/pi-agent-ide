import type { AgentContent } from "./content.js";

export interface ResourceOperationContext
{
    readonly signal?: AbortSignal;
}

export type ResourceRead = (
    context: ResourceOperationContext,
) => Promise<AgentContent>;

export type ResourceWrite = (
    content: AgentContent,
    context: ResourceOperationContext,
) => Promise<void>;

export interface ResourceBase
{
    readonly source: string;
    readonly link?: string;
}

export interface ReadableResource extends ResourceBase
{
    readonly read: ResourceRead;
    readonly write?: never;
}

export interface WritableResource extends ResourceBase
{
    readonly read?: never;
    readonly write: ResourceWrite;
}

export interface ReadWriteResource extends ResourceBase
{
    readonly read: ResourceRead;
    readonly write: ResourceWrite;
}

export type Resource = ReadableResource | WritableResource | ReadWriteResource;
