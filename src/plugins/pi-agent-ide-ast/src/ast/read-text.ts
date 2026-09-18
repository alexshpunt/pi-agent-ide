import { readFile } from "node:fs/promises";

const MAX_SOURCE_BYTES = 256 * 1024;

export interface TextFileSnapshot {
  readonly lines: string[];
  readonly content: string;
}

export async function readTextFile(filePath: string): Promise<TextFileSnapshot> {
  const buffer = await readFile(filePath);

  if (buffer.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`File exceeds the ${MAX_SOURCE_BYTES}-byte AST outline limit: ${filePath}`);
  }

  if (buffer.includes(0)) {
    throw new Error(`File appears to be binary and cannot be read as text: ${filePath}`);
  }

  const content = buffer.toString("utf8").replaceAll("\r\n", "\n");
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n");

  return { content, lines };
}
