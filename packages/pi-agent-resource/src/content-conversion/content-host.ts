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

export function createContentHost(pi: ExtensionAPI, target: ContentTarget): ContentHost {
  const runner = createContentRunner(target);

  const unsubscribeRegistration = pi.events.on(CONTENT_CONVERTER_REGISTER_EVENT, (request) => {
    if (!isContentConverterRegistrationRequest(request)) {
      throw new Error("Invalid content converter registration request");
    }

    if (!targetsEqual(runner.target, request.registration.target)) {
      return;
    }

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
  pi.on("session_shutdown", unsubscribeRegistration);
  pi.events.emit(CONTENT_HOST_READY_EVENT, {
    protocol: CONTENT_PROTOCOL,
    apiVersion: CONTENT_API_VERSION,
    target: runner.target,
  });

  return {
    target: runner.target,
    listDescriptions(): readonly ContentDescription[] {
      return runner.listDescriptions();
    },
    convert(input, context): Promise<AgentContent> {
      return runner.convert(input, context);
    },
  };
}
