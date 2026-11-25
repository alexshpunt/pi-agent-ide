import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { safeTerminalText, standalonePresentation } from "./standalone-presentation.ts";
import { ResourceError } from "pi-agent-ide/api/resource";
import type { createStandaloneResources, StandaloneResult } from "./standalone-resources.ts";

const path = Type.String({
  minLength: 1,
  description:
    "Explicit Linear resource URL or docs: guide. Use linear_read with docs:linear first.",
});
const anchor = Type.String({
  minLength: 1,
  description: "Unique exact text or a line#hash anchor returned by linear_read in this session.",
});
const namespace = {
  name: "linear",
  description: "Read, discover and change Linear resources without loading the IDE extension",
  instructions:
    "Use linear_read with docs:linear, then read the matching domain guide before acting. Use linear_read, linear_search, linear_write, linear_replace, linear_insert, linear_delete, linear_copy and linear_move where the guides name the corresponding ordinary IDE tool. Use explicit resource paths. Standalone tools accept their own line#hash anchors or unique exact text, not IDE result IDs. Fields such as #status, #assignee and #delegate can be written without reading. Read a body before editing it to get anchors, and read every changed resource again before another mutation. Standalone high-risk actions always require an interactive confirmation; IDE YOLO settings do not bypass it. Never replay unknown remote effects.",
};
const plain = (value: string) => safeTerminalText(value).replace(/[\r\n\t]/gu, " ");
/** Register only when the IDE has not accepted the Linear provider. */
export function registerStandaloneTools(
  pi: ExtensionAPI,
  resources: ReturnType<typeof createStandaloneResources>,
) {
  const definitions = [
    {
      operation: "read",
      description: "Use linear_read to inspect one Linear resource or packaged guide.",
      parameters: Type.Object(
        {
          path,
          offset: Type.Optional(
            Type.Integer({
              description: "First line, numbered from 1; negative offsets count from the end.",
            }),
          ),
          limit: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "Maximum lines. Follow the returned continuation when more remain.",
            }),
          ),
          views: Type.Optional(
            Type.Array(Type.Literal("anchors"), {
              description: "Request anchors to label returned text lines for guarded edits.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    },
    {
      operation: "search",
      description:
        "Use linear_search to discover Linear objects or find text in one selected resource.",
      parameters: Type.Object(
        {
          path,
          query: Type.String({
            minLength: 1,
            description:
              "Use linear:<kind> <terms> for API discovery, literal text for a resource, or regex:<pattern>. Read docs:linear-discovery for scopes and kinds.",
          }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          caseSensitive: Type.Optional(Type.Boolean()),
          wholeWord: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    },
    {
      operation: "write",
      description:
        "Use linear_write to create a Linear object, replace a previously read body, or submit a typed field or action payload.",
      parameters: Type.Object(
        {
          path,
          content: Type.String({
            description:
              "Complete Markdown for a body, or the typed value/JSON required by the resource's schema.",
          }),
        },
        { additionalProperties: false },
      ),
    },
    {
      operation: "replace",
      description:
        "Use linear_replace to replace one verified text selection in a Linear body or field.",
      parameters: Type.Object(
        {
          path,
          start: anchor,
          end: Type.Optional(anchor),
          text: Type.String({
            description:
              "Replacement text. With end, replace the inclusive whole-line range; otherwise replace the exact selection.",
          }),
        },
        { additionalProperties: false },
      ),
    },
    {
      operation: "insert",
      description:
        "Use linear_insert to add text at a verified line or add a typed collection member or file reference.",
      parameters: Type.Object(
        {
          path,
          anchor: Type.Optional(
            Type.String({
              description:
                "Unique exact text or line#hash for body insertion; end for label addition; omit only when the domain guide explicitly allows it.",
            }),
          ),
          text: Type.String({
            minLength: 1,
            description:
              "Text to insert, a label name, or the typed file reference required by the target.",
          }),
          before: Type.Optional(Type.Boolean()),
          separation: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("blank-line")])),
        },
        { additionalProperties: false },
      ),
    },
    {
      operation: "delete",
      description:
        "Use linear_delete to remove verified text or request a supported whole-object deletion after confirmation.",
      parameters: Type.Object(
        { path, start: Type.Optional(anchor), end: Type.Optional(anchor) },
        { additionalProperties: false },
      ),
    },
    ...["copy", "move"].map((operation) => ({
      operation,
      description:
        operation === "copy"
          ? "Use linear_copy to attach an existing Linear document reference to a supported collection."
          : "Use linear_move to rename a Linear document through its returned rename target.",
      parameters: Type.Object(
        {
          path,
          target: Type.String({
            minLength: 1,
            description:
              "Explicit Linear destination resource. Use the collection or rename target advertised by the source.",
          }),
        },
        { additionalProperties: false },
      ),
    })),
  ];
  for (const definition of definitions) {
    const name = `linear_${definition.operation}`;
    pi.registerTool({
      name,
      label: name,
      exposure: "deferred",
      namespace,
      description: definition.description,
      parameters: definition.parameters,
      annotations: {
        readOnlyHint: ["read", "search"].includes(definition.operation),
        destructiveHint: !["read", "search"].includes(definition.operation),
        openWorldHint: true,
      },
      renderCall: (args) => new Text(`${name} ${plain(args.path)}`, 0, 0),
      renderResult: (result, options, _theme, context) => {
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return new Text(
          standalonePresentation(text, result.details, context.isError, options.expanded),
          0,
          0,
        );
      },
      async execute(_id, params, signal, _update, ctx) {
        try {
          const context = { cwd: ctx.cwd, signal };
          let outcome: StandaloneResult;
          if (definition.operation === "read")
            outcome = await resources.read(params as Parameters<typeof resources.read>[0], context);
          else if (definition.operation === "search")
            outcome = await resources.search(
              params as Parameters<typeof resources.search>[0],
              context,
            );
          else
            outcome = await resources.mutate(
              definition.operation,
              params as Parameters<typeof resources.mutate>[1],
              context,
            );
          return {
            ...outcome,
            content: outcome.content.filter(
              (block) => block.type === "text" || block.type === "image",
            ),
          };
        } catch (error) {
          const code =
            error instanceof ResourceError
              ? error.code
              : error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
                ? error.message
                : signal?.aborted
                  ? "LINEAR_OPERATION_CANCELLED"
                  : "LINEAR_OPERATION_FAILED";
          const effect = error instanceof ResourceError ? error.effect : "not-applied";
          return {
            content: [
              {
                type: "text",
                text: `${code}\nSource: ${params.path}\nEffect: ${effect}. ${effect === "unknown" ? "Do not replay this operation. Inspect the target first." : "Read the resource and its domain guide before trying another change."}`,
              },
            ],
            details: { code, effect, source: params.path },
            isError: true,
          };
        }
      },
    });
  }
  const active = pi.getActiveTools();
  if (
    !active.includes("tool_search") &&
    pi.getAllTools().some((tool) => tool.name === "tool_search")
  )
    pi.setActiveTools([...active, "tool_search"]);
}
