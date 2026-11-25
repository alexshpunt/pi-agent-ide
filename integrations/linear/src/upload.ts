import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decodeAxiObject, runAxi } from "./axi.ts";
import { assetAddress, checkedAssetUrl } from "./asset-address.ts";
import { parseIssueUrl } from "./urls.ts";

const uploadParameters = Type.Object({
  file: Type.String({
    description: "Existing local regular file, at most 25 MiB; original bytes are preserved.",
  }),
  workspace: Type.String({ description: "Explicit Linear workspace slug." }),
  issue: Type.Optional(
    Type.String({
      description:
        "Optional issue identifier or native issue URL; omit to upload without attaching.",
    }),
  ),
  title: Type.Optional(
    Type.String({ description: "Optional issue attachment title; defaults to the filename." }),
  ),
  contentType: Type.Optional(
    Type.String({
      description:
        "Optional MIME type; known file extensions are detected, otherwise application/octet-stream.",
    }),
  ),
});
type UploadInput = Static<typeof uploadParameters>;
type Effect = "applied" | "not-applied" | "unknown";
export type LinearUploadReceipt = {
  readonly workspace: string;
  readonly upload: Effect;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly assetUrl?: string;
  readonly read?: string;
  readonly error?: string;
  readonly attachment?: {
    readonly effect: Effect;
    readonly id?: string;
    readonly url?: string;
    readonly error?: string;
  };
};

/** Upload through AXI's existing app authorization; no credentials cross into this package. */
export function createAxiUploader(run: typeof runAxi = runAxi) {
  return async (
    input: UploadInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<LinearUploadReceipt> => {
    if (!/^[A-Za-z0-9_-]+$/u.test(input.workspace)) throw new Error("LINEAR_INVALID_WORKSPACE");
    let issue = input.issue;
    if (issue && !/^[A-Z][A-Z0-9]*-\d+$/u.test(issue)) {
      const url = parseIssueUrl(issue);
      if (!url || url.workspace !== input.workspace) throw new Error("LINEAR_IDENTITY_MISMATCH");
      issue = url.identifier;
    }
    const output = await run(
      cwd,
      [
        "assets",
        "upload",
        "--workspace",
        input.workspace,
        "--file",
        input.file,
        ...(issue ? ["--issue", issue] : []),
        ...(input.title ? ["--title", input.title] : []),
        ...(input.contentType ? ["--content-type", input.contentType] : []),
      ],
      signal,
    );
    const raw = decodeAxiObject(output, "upload", [
      "workspace",
      "upload",
      "filename",
      "size",
      "sha256",
      "assetUrl",
      "error",
      "attachment",
    ]).upload;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("LINEAR_INVALID_UPLOAD_RECEIPT");
    const row = raw as LinearUploadReceipt;
    if (
      row.workspace !== input.workspace ||
      !["applied", "not-applied", "unknown"].includes(row.upload) ||
      typeof row.filename !== "string" ||
      /[\r\n\0]/u.test(row.filename) ||
      typeof row.sha256 !== "string" ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > 25 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(row.sha256)
    )
      throw new Error("LINEAR_INVALID_UPLOAD_RECEIPT");
    if (row.error !== undefined && !/^LINEAR_[A-Z_]+$/u.test(row.error))
      throw new Error("LINEAR_INVALID_UPLOAD_RECEIPT");
    if (
      row.attachment !== undefined &&
      (!issue ||
        !["applied", "not-applied", "unknown"].includes(row.attachment.effect) ||
        (row.attachment.error !== undefined && !/^LINEAR_[A-Z_]+$/u.test(row.attachment.error)))
    )
      throw new Error("LINEAR_INVALID_UPLOAD_RECEIPT");
    if (row.upload === "applied" && (!row.assetUrl || (issue && !row.attachment)))
      throw new Error("LINEAR_INVALID_UPLOAD_RECEIPT");
    const receipt: LinearUploadReceipt = {
      workspace: row.workspace,
      upload: row.upload,
      filename: row.filename,
      size: row.size,
      sha256: row.sha256,
      ...(row.error ? { error: row.error } : {}),
      ...(row.attachment
        ? {
            attachment: {
              effect: row.attachment.effect,
              ...(typeof row.attachment.id === "string" ? { id: row.attachment.id } : {}),
              ...(typeof row.attachment.url === "string" ? { url: row.attachment.url } : {}),
              ...(row.attachment.error ? { error: row.attachment.error } : {}),
            },
          }
        : {}),
    };
    if (row.assetUrl) {
      checkedAssetUrl(row.assetUrl);
      if (
        row.attachment?.effect === "applied" &&
        (typeof row.attachment.id !== "string" ||
          !row.attachment.id ||
          row.attachment.id.length > 200 ||
          row.attachment.url !== row.assetUrl)
      )
        throw new Error("LINEAR_INVALID_UPLOAD_RECEIPT");
      return {
        ...receipt,
        assetUrl: row.assetUrl,
        read: assetAddress(input.workspace, row.assetUrl),
      };
    }
    return receipt;
  };
}

/** The binary exception: keep completed upload links visible even when attachment fails. */
export function createLinearUploadTool(
  upload = createAxiUploader(),
): ToolDefinition<typeof uploadParameters> {
  return {
    name: "linear_upload",
    label: "Upload to Linear",
    description:
      "Upload a local binary file through existing Linear authorization. Returns a private asset and Read link. Attach only to an explicit issue; upload and attachment have separate effects. Never retry an unknown result or change authorization scopes automatically.",
    parameters: uploadParameters,
    async execute(_id, input, signal, _onUpdate, context) {
      try {
        const receipt = await upload(input, context.cwd, signal);
        const failed =
          receipt.error !== undefined ||
          receipt.upload !== "applied" ||
          (receipt.attachment !== undefined && receipt.attachment.effect !== "applied");
        const effect: Effect =
          receipt.upload === "unknown" || receipt.attachment?.effect === "unknown"
            ? "unknown"
            : receipt.upload;
        const text = [
          `Upload: ${receipt.upload} (${receipt.filename}, ${receipt.size} bytes)`,
          `SHA-256: ${receipt.sha256}`,
          ...(receipt.assetUrl ? [`Asset: ${receipt.assetUrl}`, `Read: ${receipt.read}`] : []),
          ...(receipt.error ? [`Error: ${receipt.error}`] : []),
          ...(receipt.attachment
            ? [
                `Attachment: ${receipt.attachment.effect}${receipt.attachment.id ? ` (${receipt.attachment.id})` : ""}`,
                ...(receipt.attachment.error
                  ? [`Attachment error: ${receipt.attachment.error}`]
                  : []),
              ]
            : [
                input.issue
                  ? "Issue attachment was not reached."
                  : "No issue attachment requested.",
              ]),
          ...(effect === "unknown"
            ? [
                "Outcome is uncertain. Inspect the asset/issue before any retry; do not upload or attach again blindly.",
              ]
            : []),
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { effect, receipt },
          structuredContent: { effect, receipt },
          isError: failed,
        };
      } catch (error) {
        const code =
          error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
            ? error.message
            : "LINEAR_UPLOAD_FAILED";
        const effect = [
          "LINEAR_AXI_NOT_FOUND",
          "LINEAR_INVALID_WORKSPACE",
          "LINEAR_IDENTITY_MISMATCH",
          "LINEAR_GRAPHQL_AUTH_REQUIRED",
          "LINEAR_AUTH_REQUIRED",
          "LINEAR_FILE_UNSUPPORTED_OR_TOO_LARGE",
        ].includes(code)
          ? "not-applied"
          : "unknown";
        return {
          content: [
            {
              type: "text",
              text: `${code}. Effect: ${effect}. No automatic retry or authorization change.`,
            },
          ],
          details: { effect },
          isError: true,
        };
      }
    },
  };
}
