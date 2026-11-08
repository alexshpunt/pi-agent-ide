import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import {
  type PresentedTextRow,
  renderPresentedTextRows,
  type TextChangeMarker,
} from "./presented-text.ts";

export interface TextLinePresentation {
  readonly prefix?: string;
  readonly suffix?: string;
  /** Optional user-facing prefix used by compact TUI renderers. */
  readonly compactPrefix?: string;
  /** Optional user-facing suffix used by compact TUI renderers. */
  readonly compactSuffix?: string;
  readonly marker?: TextChangeMarker;
  readonly before?: readonly PresentedTextRow[];
  readonly after?: readonly PresentedTextRow[];
}

export interface TextLine {
  /** Complete edit selectors supplied by configured presenters, without display markup. */
  readonly anchors?: readonly string[];
  readonly lineNumber: number;
  readonly content: string;
  readonly lineEnding: string;
  readonly presentation?: TextLinePresentation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TextDocument {
  /** Resolver-owned selectors for source-level actions, separate from display annotations. */
  readonly references?: readonly {
    readonly value: string;
    readonly kind: string;
    readonly state?: string;
  }[];
  readonly source: string;
  readonly content: string;
  readonly lines: readonly TextLine[];
}

export interface TextPresentationContext {
  /** Physical file snapshot retained by Read. Derived views clear it; edit-diff callers may omit it. */
  readonly sourceText?: string;
  readonly purpose: "read" | "edit-diff";
  /** Script data enrichment differs from explicitly requested views. */
  readonly audience?: "agent" | "script";
  readonly requestedViews?: readonly string[];
  /**
   * Lines the result shows: the requested range of a read, or the after-document lines of an
   * edit result. Other lines may stay unpresented.
   */
  readonly lineNumbers?: ReadonlySet<number>;
  readonly source: string;
  readonly cwd: string;
  readonly resolvedBy: string;
  readonly signal?: AbortSignal;
}

export interface TextLinePresenter {
  readonly id: string;
  present(
    document: TextDocument,
    context: TextPresentationContext,
  ): TextDocument | Promise<TextDocument>;
}

export interface TextPresenterRegistration {
  readonly presenter: TextLinePresenter;
  readonly priority?: number;
}

const functionSchema = Type.Function([], Type.Unknown());
const presenterSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  present: functionSchema,
});
const registrationSchema = Type.Object({
  presenter: presenterSchema,
  priority: Type.Optional(Type.Number()),
});

export function isTextLinePresenter(value: unknown): value is TextLinePresenter {
  return safeCheck(presenterSchema, value);
}

export function isTextPresenterRegistration(value: unknown): value is TextPresenterRegistration {
  return safeCheck(registrationSchema, value);
}

/** Texts below this size are split again; reuse matters only for large files. */
const REUSE_MIN_LENGTH = 64 * 1024;
const REUSE_LIMIT = 2;
const REUSE_MS = 2000;
/**
 * Recently split large documents. One edit or read of a large file splits the same text several
 * times, in Read, the editor, search and result checks, and each split holds an object per line.
 * The documents are released shortly after the last split, so an idle Pi keeps none of them.
 */
const recentDocuments: TextDocument[] = [];
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/** Splits text into lines. Documents are immutable, so the same text may return the same one. */
export function createTextDocument(source: string, content: string): TextDocument {
  if (content.length < REUSE_MIN_LENGTH) return { source, content, lines: splitTextLines(content) };
  const reused = recentDocuments.find(
    (document) => document.source === source && document.content === content,
  );
  if (reused !== undefined) return reused;
  const document: TextDocument = { source, content, lines: Object.freeze(splitTextLines(content)) };
  recentDocuments.unshift(document);
  recentDocuments.length = Math.min(recentDocuments.length, REUSE_LIMIT);
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    recentDocuments.length = 0;
  }, REUSE_MS);
  releaseTimer.unref();
  return document;
}

export function renderTextDocument(document: TextDocument): string {
  return document.lines.map((line) => `${line.content}${line.lineEnding}`).join("");
}

/** Controls whether user-facing compact presentation fields replace their full forms. */
export interface PresentedTextDocumentRenderOptions {
  readonly compact?: boolean;
}

/** Renders a text document with its presenter-owned annotations. */
export function renderPresentedTextDocument(
  document: TextDocument,
  options: PresentedTextDocumentRenderOptions = {},
): string {
  const rows = document.lines.flatMap((line) => [
    ...(line.presentation?.before ?? []),
    presentedRowFor(line, options.compact === true),
    ...(line.presentation?.after ?? []),
  ]);
  const rendered = renderPresentedTextRows(rows);
  let rowIndex = 0;

  return document.lines
    .map((line) => {
      const lineRowCount =
        1 + (line.presentation?.before?.length ?? 0) + (line.presentation?.after?.length ?? 0);
      const output = rendered.slice(rowIndex, rowIndex + lineRowCount).join("\n");
      rowIndex += lineRowCount;
      return `${output}${line.lineEnding}`;
    })
    .join("");
}

function presentedRowFor(line: TextLine, compact: boolean): PresentedTextRow {
  const prefix =
    compact && line.presentation?.compactPrefix !== undefined
      ? line.presentation.compactPrefix
      : line.presentation?.prefix;
  const suffix =
    compact && line.presentation?.compactSuffix !== undefined
      ? line.presentation.compactSuffix
      : line.presentation?.suffix;
  return {
    content: line.content,
    ...(prefix !== undefined && { prefix }),
    ...(suffix !== undefined && { suffix }),
    ...(line.presentation?.marker !== undefined && { marker: line.presentation.marker }),
  };
}

function splitTextLines(content: string): TextLine[] {
  if (content.length === 0) {
    return [];
  }

  const lines: TextLine[] = [];
  if (!content.includes("\r")) {
    // LF-only text, the common case: indexOf scans much faster than a line-ending regex.
    let start = 0;
    for (let end = content.indexOf("\n"); end !== -1; end = content.indexOf("\n", start)) {
      lines.push({
        lineNumber: lines.length + 1,
        content: content.slice(start, end),
        lineEnding: "\n",
      });
      start = end + 1;
    }
    if (start < content.length) {
      lines.push({ lineNumber: lines.length + 1, content: content.slice(start), lineEnding: "" });
    }
    return lines;
  }

  const endings = /\r\n|\r|\n/gu;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = endings.exec(content)) !== null) {
    lines.push({
      lineNumber: lines.length + 1,
      content: content.slice(start, match.index),
      lineEnding: match[0],
    });
    start = match.index + match[0].length;
  }
  if (start < content.length) {
    lines.push({ lineNumber: lines.length + 1, content: content.slice(start), lineEnding: "" });
  }
  return lines;
}

function safeCheck(schema: TSchema, value: unknown): boolean {
  try {
    return Value.Check(schema, value);
  } catch {
    return false;
  }
}
