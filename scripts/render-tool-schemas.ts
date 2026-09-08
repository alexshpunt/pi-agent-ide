import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  raw: unknown;
}
interface Request {
  model: unknown;
  tools: Tool[];
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Accepts a tool array, provider request, or JSONL capture; preserves each request. */
export function parseToolCapture(source: string): Request[] {
  let records: unknown[];
  try {
    records = [JSON.parse(source) as unknown];
  } catch {
    records = source
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line): unknown => JSON.parse(line));
  }
  if (records.length === 0) throw new Error("The capture is empty");
  return records.map((record, index) => {
    const tools: unknown = Array.isArray(record) ? record : object(record).tools;
    if (!Array.isArray(tools)) throw new Error(`Request ${index + 1}: tools must be an array`);
    return {
      model: object(record).model,
      tools: tools.map((entry: unknown) => {
        const tool = object(object(entry).function ?? entry);
        if (
          typeof tool.name !== "string" ||
          typeof tool.description !== "string" ||
          tool.parameters === undefined
        ) {
          throw new Error(`Request ${index + 1}: unsupported tool definition`);
        }
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          raw: entry,
        };
      }),
    };
  });
}
function cell(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replace(/\r?\n/gu, "<br>");
}
function fenced(value: string, language = ""): string {
  const longest = Math.max(2, ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}
function typeOf(value: unknown): string {
  if (typeof value === "boolean") return value ? "any" : "never";
  const schema = object(value);
  if (schema.type === "array")
    return `array<${schema.items === undefined ? "any" : typeOf(schema.items)}>`;
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeOf).join(" | ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(typeOf).join(" | ");
  return typeof schema.$ref === "string" ? schema.$ref : "unspecified";
}
function fields(value: unknown, prefix = ""): string[] {
  const schema = object(value);
  return Object.entries(object(schema.properties)).flatMap(([name, property]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    const p = object(property);
    const constraints = Object.fromEntries(
      Object.entries(p).filter(
        ([key]) => !["type", "description", "properties", "items", "required"].includes(key),
      ),
    );
    const required = Array.isArray(schema.required) && schema.required.includes(name);
    const row = `| ${cell(path)} | ${cell(typeOf(property))} | ${required ? "yes" : "no"} | ${cell(JSON.stringify(constraints))} | ${cell(p.description ?? "")} |`;
    return [row, ...fields(property, path), ...fields(p.items, `${path}[]`)];
  });
}

/** Produces a review document without dropping raw schema fields or changed request versions. */
export function renderToolCapture(requests: Request[], prompt?: string): string {
  const output = ["# Agent prompt and tool contracts"];
  if (prompt !== undefined) output.push("## System prompt", fenced(prompt, "text"));
  const seen = new Map<string, number>();
  for (const [index, request] of requests.entries()) {
    output.push(`## Request ${index + 1}`, `Model: ${cell(request.model ?? "not recorded")}`);
    const key = JSON.stringify(request.tools.map((tool) => tool.raw));
    if (seen.has(key)) {
      output.push(`Tool definitions are identical to request ${seen.get(key)}.`);
      continue;
    }
    seen.set(key, index + 1);
    for (const tool of request.tools) {
      output.push(
        `### ${cell(tool.name)}`,
        "**Full tool description**",
        tool.description,
        "**Parameters** — required refers to the immediate containing object.",
        [
          "| Parameter | Type | Required | Constraints | Description |",
          "| --- | --- | --- | --- | --- |",
          ...fields(tool.parameters),
        ].join("\n"),
        "<details><summary>Complete original definition (including nested alternatives and object-level constraints)</summary>\n",
        fenced(JSON.stringify(tool.raw, null, 2), "json"),
        "</details>",
      );
    }
  }
  return `${output.join("\n\n")}\n`;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [input, output, promptPath] = args;
  if (!input || !output || args.length > 3)
    throw new Error(
      "Usage: pnpm exec oxnode scripts/render-tool-schemas.ts <capture.json|jsonl> <review.md> [system-prompt.txt]",
    );
  const requests = parseToolCapture(await readFile(input, "utf8"));
  const prompt = promptPath === undefined ? undefined : await readFile(promptPath, "utf8");
  await writeFile(output, renderToolCapture(requests, prompt), "utf8");
  console.log(output);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
