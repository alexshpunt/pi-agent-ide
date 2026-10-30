import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { IdeCapabilitySchema } from "#src/api/capabilities.js";

function joinUnique(values: readonly (string | undefined)[]): string {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== "")),
  ].join("\n");
}

/** Compose from the original definition on every refresh; never accumulate earlier revisions. */
export function composeCapabilitySchema<
  T extends Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines">,
>(base: T, contributions: readonly IdeCapabilitySchema[]): T {
  if (contributions.length === 0) return base;
  const source = base.parameters as { properties?: Record<string, Record<string, unknown>> };
  if (source.properties === undefined)
    throw new Error(`Capability target is not an object schema: ${base.name}`);
  const properties = { ...source.properties };
  for (const contribution of contributions) {
    for (const parameter of Object.keys(contribution.parameters ?? {})) {
      if (!Object.hasOwn(properties, parameter))
        throw new Error(`Unknown capability parameter: ${base.name}.${parameter}`);
    }
  }
  for (const [parameter, schema] of Object.entries(properties)) {
    const additions = contributions.map((item) => item.parameters?.[parameter]);
    if (additions.some((value) => value !== undefined)) {
      properties[parameter] = {
        ...schema,
        description: joinUnique([
          typeof schema.description === "string" ? schema.description : undefined,
          ...additions,
        ]),
      };
    }
  }
  return {
    ...base,
    // Pi's in-flight run can retain the previous toolGuidelines map. Include activated rules
    // in the declaration too, so the next tool-state revision delivers them without a new turn.
    description: joinUnique([
      base.description,
      ...contributions.flatMap((item) => [item.description, ...(item.promptGuidelines ?? [])]),
    ]),
    parameters: { ...base.parameters, properties },
    promptGuidelines: [
      ...new Set([
        ...(base.promptGuidelines ?? []),
        ...contributions.flatMap((item) => item.promptGuidelines ?? []),
      ]),
    ],
  };
}
