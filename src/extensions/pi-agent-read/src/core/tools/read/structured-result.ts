import { Type } from "typebox";
import { ResourceError, structuredResultSchema, withStructuredResult } from "pi-agent-resource";
import type { ReadScriptData, ReadToolResult } from "#src/api/tools/read.js";
import type { TextLine } from "pi-agent-text";

const reference = Type.Object(
  { value: Type.String(), kind: Type.String(), state: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const line = Type.Object(
  {
    lineNumber: Type.Integer(),
    content: Type.String(),
    lineEnding: Type.String(),
    anchors: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
const continuation = Type.Object(
  { path: Type.String(), offset: Type.Integer() },
  { additionalProperties: false },
);
const common = {
  source: Type.String(),
  truncated: Type.Boolean(),
  continuation: Type.Optional(continuation),
  fullResult: Type.Optional(Type.String()),
};
const text = Type.Object(
  {
    ...common,
    kind: Type.Literal("text"),
    target: Type.Optional(Type.String()),
    lines: Type.Array(line),
    startLine: Type.Integer(),
    endLine: Type.Integer(),
    totalLines: Type.Integer(),
    references: Type.Optional(Type.Array(reference)),
  },
  { additionalProperties: false },
);
const bytes = Type.Object(
  {
    ...common,
    kind: Type.Literal("bytes"),
    bytes: Type.Array(Type.Integer({ minimum: 0, maximum: 255 })),
    byteOffset: Type.Integer(),
    byteLength: Type.Integer(),
    totalBytes: Type.Integer(),
  },
  { additionalProperties: false },
);
const block = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("image"), mimeType: Type.String() },
    { additionalProperties: false },
  ),
]);
const native = Type.Object(
  { ...common, kind: Type.Literal("native"), blocks: Type.Array(block) },
  { additionalProperties: false },
);
export const readDataSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("recovery"),
      source: Type.String(),
      candidates: Type.Array(Type.Object({ path: Type.String() }, { additionalProperties: false })),
    },
    { additionalProperties: false },
  ),
  text,
  bytes,
  native,
  Type.Object(
    {
      kind: Type.Literal("resources"),
      source: Type.Optional(Type.String()),
      resources: Type.Array(Type.Union([text, bytes, native])),
      truncated: Type.Boolean(),
      fullResult: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);
export const readOutputSchema = structuredResultSchema(readDataSchema);

function publicLine(value: TextLine) {
  return {
    lineNumber: value.lineNumber,
    content: value.content,
    lineEnding: value.lineEnding,
    ...(value.anchors === undefined ? {} : { anchors: [...value.anchors] }),
  };
}
/** Bound selected data, not source snapshots or human-facing presentation. */
function publicData(value: ReadScriptData): unknown {
  if (value.kind === "resources") {
    const resources = value.resources.map((resource) => publicData(resource));
    return {
      kind: value.kind,
      ...(value.source === undefined ? {} : { source: value.source }),
      resources,
      truncated: resources.some(
        (resource) =>
          typeof resource === "object" &&
          resource !== null &&
          "truncated" in resource &&
          resource.truncated === true,
      ),
    };
  }
  if (value.kind === "bytes") {
    const bytes = value.bytes.slice(0, 32768);
    const truncated = value.truncated === true || bytes.length < value.bytes.length;
    return {
      kind: value.kind,
      source: value.source,
      bytes,
      byteOffset: value.byteOffset,
      byteLength: bytes.length,
      totalBytes: value.totalBytes,
      truncated,
      ...(value.byteOffset + bytes.length < value.totalBytes
        ? { continuation: { path: value.source, offset: value.byteOffset + bytes.length } }
        : {}),
    };
  }
  // Image bytes belong to native content, not the composable result record.
  if (value.kind === "native")
    return {
      kind: value.kind,
      source: value.source,
      truncated: false,
      blocks: value.blocks.map((block) => {
        if (block.type === "text") return { type: block.type, text: block.text };
        if (block.type === "image") return { type: block.type, mimeType: block.mimeType };
        throw new TypeError("Custom content requires a structured adapter");
      }),
    };
  const lines = [];
  let size = 0;
  for (const line of value.lines) {
    const projected = publicLine(line);
    size += Buffer.byteLength(JSON.stringify(projected));
    if (lines.length >= 2000 || size > 512 * 1024) break;
    lines.push(projected);
  }
  if (lines.length === 0 && value.lines.length > 0)
    throw new RangeError(
      "Selected line exceeds the structured window; use a raw byte range or a source-specific view",
    );
  const truncated = lines.length < value.lines.length;
  const endLine = lines.at(-1)?.lineNumber ?? value.startLine - 1;
  // Continue against the resolved source with absolute line numbers, not a relative selector.
  return {
    kind: value.kind,
    source: value.source,
    ...(value.target === undefined ? {} : { target: value.target }),
    lines,
    startLine: lines[0]?.lineNumber ?? 0,
    endLine: lines.at(-1)?.lineNumber ?? 0,
    totalLines: value.totalLines,
    truncated,
    ...(value.target === undefined ? {} : { target: value.target }),
    ...(value.references === undefined ? {} : { references: value.references }),
    ...(truncated || endLine < value.totalLines
      ? { continuation: { path: value.source, offset: endLine + 1 } }
      : {}),
  };
}

/** Require resolver-owned script data. Never reconstruct it from rendered content or renderer details. */
export function structuredRead(result: ReadToolResult): ReadToolResult {
  const failure = result.details.failure;
  const safe = failure?.cause instanceof ResourceError ? failure.cause : undefined;
  if (result.isError || failure !== undefined)
    return withStructuredResult(result, readDataSchema, {
      status: "error",
      ...(failure?.candidates?.length && failure.source !== undefined
        ? {
            data: { kind: "recovery", source: failure.source, candidates: failure.candidates },
          }
        : {}),
      errors: [
        {
          code: safe?.code ?? failure?.code ?? "READ_FAILED",
          message:
            safe === undefined
              ? (failure?.message ?? "Read failed")
              : `${safe.code}: ${failure?.source ?? safe.source}`,
          ...(failure?.source === undefined ? {} : { source: failure.source }),
        },
      ],
    });
  try {
    if (result.script === undefined)
      throw new TypeError("Read handler must return structured script data");
    const data = publicData(result.script);
    return withStructuredResult(result, readDataSchema, {
      status: "success",
      data:
        result.details.temporarySource !== undefined && typeof data === "object" && data !== null
          ? { ...data, fullResult: result.details.temporarySource }
          : data,
      errors: [],
    });
  } catch (error) {
    return withStructuredResult(result, readDataSchema, {
      status: "error",
      errors: [
        {
          code:
            error instanceof RangeError
              ? "STRUCTURED_RESULT_TOO_LARGE"
              : "STRUCTURED_ADAPTER_REQUIRED",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    });
  }
}
