import { createContentRunner, targetsEqual } from "./content-runner.js";
import {
  CONTENT_API_VERSION,
  CONTENT_CONVERTER_REGISTER_EVENT,
  CONTENT_HOST_READY_EVENT,
  CONTENT_PROTOCOL,
  isContentConverterRegistrationRequest,
} from "./plugin-protocol.js";

import type {
  ContentConversionContext,
  ContentDescription,
  ContentInput,
  ContentTarget,
} from "./content-converter.js";
import type { AgentContent } from "#src/content.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ContentHost {
  readonly target: ContentTarget;
  listDescriptions(): readonly ContentDescription[];
  convert(input: ContentInput, context: ContentConversionContext): Promise<AgentContent>;
}

interface SharedContentHost {
  readonly host: ContentHost;
  readonly owners: Set<ExtensionAPI>;
  readonly unsubscribe: () => void;
}

const CONTENT_HOST_LOOKUP_EVENT = "pi-agent-resource:content-host-lookup";

interface HostLookup {
  readonly target: ContentTarget;
  accept(entry: SharedContentHost): void;
}

/** Share installed converters by exact target within one Pi event bus and owner lifetime. */
export function createContentHost(pi: ExtensionAPI, target: ContentTarget): ContentHost {
  let existing: SharedContentHost | undefined;
  pi.events.emit(CONTENT_HOST_LOOKUP_EVENT, {
    target,
    accept(entry: SharedContentHost): void {
      if (existing) throw new Error("Multiple content hosts registered for one target");
      existing = entry;
    },
  } satisfies HostLookup);
  if (existing) {
    retainOwner(pi, existing);
    return existing.host;
  }
  const runner = createContentRunner(target);
  const unsubscribe = pi.events.on(CONTENT_CONVERTER_REGISTER_EVENT, (request) => {
    if (!isContentConverterRegistrationRequest(request)) {
      throw new Error("Invalid content converter registration request");
    }
    if (!targetsEqual(runner.target, request.registration.target)) return;

    let registration: Promise<void>;
    try {
      runner.register(request.registration);
      registration = Promise.resolve();
    } catch (error) {
      registration = Promise.reject(
        error instanceof Error
          ? error
          : new Error("Content converter registration failed", { cause: error }),
      );
    }
    request.accept(registration);
  });
  const host: ContentHost = {
    target: runner.target,
    listDescriptions(): readonly ContentDescription[] {
      return runner.listDescriptions();
    },
    convert(input, context): Promise<AgentContent> {
      return runner.convert(input, context);
    },
  };
  const stopLookup = pi.events.on(CONTENT_HOST_LOOKUP_EVENT, (request) => {
    if (!isHostLookup(request)) throw new Error("Invalid content host lookup request");
    if (targetsEqual(target, request.target)) request.accept(entry);
  });
  const entry: SharedContentHost = {
    host,
    owners: new Set(),
    unsubscribe(): void {
      unsubscribe();
      stopLookup();
    },
  };
  retainOwner(pi, entry);
  pi.events.emit(CONTENT_HOST_READY_EVENT, {
    protocol: CONTENT_PROTOCOL,
    apiVersion: CONTENT_API_VERSION,
    target: runner.target,
  });
  return host;
}

function isHostLookup(value: unknown): value is HostLookup {
  return (
    typeof value === "object" &&
    value !== null &&
    "target" in value &&
    typeof value.target === "object" &&
    value.target !== null &&
    "provider" in value.target &&
    typeof value.target.provider === "string" &&
    "capability" in value.target &&
    typeof value.target.capability === "string" &&
    "accept" in value &&
    typeof value.accept === "function"
  );
}

function retainOwner(pi: ExtensionAPI, entry: SharedContentHost): void {
  if (entry.owners.has(pi)) return;
  entry.owners.add(pi);
  pi.on("session_shutdown", () => {
    entry.owners.delete(pi);
    if (entry.owners.size === 0) {
      entry.unsubscribe();
    }
  });
}
