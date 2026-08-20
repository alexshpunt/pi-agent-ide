import type {
  AgentContent,
  ContentConversionAttempt,
  ContentConversionContext,
  ContentConverter,
  ContentInput,
} from "pi-agent-resource";

const textualAppMediaTypes = new Set([
  "application/ecmascript",
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-www-form-urlencoded",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

export function createTextContentConverter(): ContentConverter {
  return {
    id: "text",
    description: "UTF-8 text.",
    tryConvert(input, context) {
      return Promise.resolve(convertText(input, context));
    },
  };
}

function convertText(
  input: ContentInput,
  context: ContentConversionContext,
): ContentConversionAttempt {
  const cancellation = cancellationError(context.signal);

  if (cancellation !== undefined) {
    return { kind: "failed", error: cancellation };
  }

  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(input.bytes);
    return { kind: "converted", content: [{ type: "text", text }] };
  } catch (error) {
    if (!isTextualMediaType(input.mediaType)) {
      return { kind: "not-handled" };
    }

    return {
      kind: "failed",
      error: new TypeError(`${input.source} is not valid UTF-8 text`, { cause: error }),
    };
  }
}

export function isTextualMediaType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("text/") ||
    textualAppMediaTypes.has(mediaType) ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  );
}

export function textFromAgentContent(content: AgentContent): string {
  const block = content[0];

  if (content.length !== 1 || block.type !== "text") {
    throw new TypeError("Text resources require exactly one text block");
  }

  return block.text;
}

function cancellationError(signal: AbortSignal | undefined): Error | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }

  return signal.reason instanceof Error ? signal.reason : abortError();
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
