import { expect, test } from "vitest";
import * as exporter from "./export-agent-interface.js";

const parameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "A file.\nfile:// is supported." },
    views: { type: "array", items: { type: "string" }, description: "anchors — line references" },
  },
  required: ["path"],
};

const declaration = `declare const tools: { read(args: {
  // A file.
  path: string;
  views?: Array<string>;
}): Promise<{ status: "success"; data: { source: string; }; } | { status: "error"; errors: Array<{ message: string; }>; }>; };`;
const description =
  "Read a resource.\n\nCodemode: `tools.read(args)` resolves to `{ status, data?, errors }`.";
const reply = `Read a resource.\n\ncodemode tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;

function capture() {
  return {
    systemPrompt: `Captured text\n${process.cwd()}/file.txt`,
    activeTools: ["read"],
    tools: [
      {
        name: "read",
        description,
        parameters,
        constrainedSampling: false as const,
        promptGuidelines: ["Registered-only metadata"],
        codemodeDeclaration: declaration,
      },
    ],
  };
}

test("exports initial request fields unchanged without registered-only or discovery metadata", () => {
  const original = capture();
  const markdown = exporter.renderMarkdown(original, process.cwd());
  expect(markdown).toContain(original.systemPrompt);
  expect(markdown).toContain(description);
  expect(markdown).toContain(JSON.stringify(parameters, null, 2));
  expect(markdown).toContain('"constrainedSampling": false');
  expect(markdown).not.toContain("Registered-only metadata");
  expect(markdown).not.toContain(declaration);
  expect(markdown).not.toContain("### Codemode signature");
  expect(original).toEqual(capture());
});

test("exports formatted discovery replies separately and retains their exact text", async () => {
  const samples = [{ name: "read", description: reply }];
  const markdown = await exporter.renderDeclarationsMarkdown(samples, process.cwd());
  expect(markdown).toContain("```ts\ndeclare const tools: {\n");
  expect(markdown).toContain('status: "error";');
  expect(markdown).toContain(`\`\`\`\`text\n${reply}\n\`\`\`\``);
  expect(markdown).not.toContain(capture().systemPrompt);
  expect(samples).toEqual([{ name: "read", description: reply }]);
});

test("keeps nested code fences intact in the initial request text", () => {
  const original = capture();
  const raw = "Example:\n```js\ncall();\n```";
  const markdown = exporter.renderMarkdown(
    {
      ...original,
      tools: [{ name: "read", parameters, description: raw }],
    },
    process.cwd(),
  );
  expect(markdown).toContain(`\`\`\`\`text\n${raw}\n\`\`\`\``);
});
