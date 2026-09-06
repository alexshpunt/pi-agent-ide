import type { TextEditIntent } from "#src/api/edit-completion.js";
import type { TextChange, TextChangeDocument } from "#src/core/text-change-engine.js";
import type { TextAnchor } from "pi-agent-text";
import type { Static, TSchema } from "typebox";

export interface TextMutationEdit {
  readonly changes: readonly TextChange[];
  readonly action: "edited" | "overwritten";
}

export interface TextMutation {
  readonly edits: ReadonlyMap<string, TextMutationEdit>;
  readonly afterWrite?: () => void | Promise<void>;
}

export interface TextMutationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly sourceDocument: TextChangeDocument;
  targetDocument(field: string): TextChangeDocument;
  sourceFor(field: string): string;
  documentFor(source: string): TextChangeDocument;
  resolveAnchors(field: string): Promise<ReadonlyMap<string, TextAnchor>>;
  resolveAnchor(field: string): Promise<TextAnchor>;
}

export interface TextMutationSourceDescriptor {
  readonly field: string;
  readonly inherited?: boolean;
  readonly targets?: readonly TextMutationTargetSource[];
}

export interface TextMutationTargetSource {
  readonly field: string;
  readonly fallbackTo: string;
}

export interface TextMutationAnchorField {
  readonly field: string;
  readonly sourceField: string;
  readonly kinds: readonly string[];
  readonly optional?: boolean;
  /** Values handled by the mutation itself instead of an anchor resolver. */
  readonly nonAnchorValues?: readonly string[];
}

/** Returns whether a supplied field value must be resolved as an anchor. */
export function isMutationAnchorValue(
  descriptor: TextMutationAnchorField,
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    descriptor.nonAnchorValues?.includes(value) !== true
  );
}

export type TextMutationIntent = Exclude<TextEditIntent, "mixed">;

export interface TextMutationToolRegistration<TParameters extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;

  /** Short capability summary shown in Pi's Available tools list. */
  readonly promptSnippet?: string;
  /** Operational guidelines shown while this mutation tool is active. */
  readonly promptGuidelines?: readonly string[];
  readonly parameters: TParameters;
  readonly intent?: TextMutationIntent;
  readonly source: TextMutationSourceDescriptor;
  readonly anchors?: readonly TextMutationAnchorField[];
  readonly pair?: readonly [string, string];
  readonly mutate: (
    context: TextMutationContext,
    parameters: Static<TParameters>,
  ) => TextMutation | Promise<TextMutation>;
}

export type AnyTextMutationToolRegistration = TextMutationToolRegistration;

export type TextMutationToolListener = (registration: AnyTextMutationToolRegistration) => void;

export function assertTextMutationToolRegistration(value: AnyTextMutationToolRegistration): void {
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new TypeError("Mutation tool name must be a non-empty string");
  }

  if (typeof value.description !== "string" || typeof value.mutate !== "function") {
    throw new TypeError(`Mutation tool ${value.name} has an invalid description or operation`);
  }

  const intent: unknown = (value as { readonly intent?: unknown }).intent;

  if (intent !== undefined && intent !== "edit" && intent !== "restore") {
    throw new TypeError(`Mutation tool ${value.name} has an invalid intent`);
  }

  const properties = schemaProperties(value.parameters, value.name);
  assertProperty(properties, value.source.field, `${value.name} primary source`);
  const sourceFields = new Set([value.source.field]);

  for (const target of value.source.targets ?? []) {
    assertProperty(properties, target.field, `${value.name} target source`);

    if (!sourceFields.has(target.fallbackTo)) {
      throw new TypeError(
        `Mutation tool ${value.name} target ${target.field} has an unknown fallback ${target.fallbackTo}`,
      );
    }

    sourceFields.add(target.field);
  }

  const anchorFields = new Set<string>();

  for (const anchor of value.anchors ?? []) {
    assertProperty(properties, anchor.field, `${value.name} anchor`);

    if (!sourceFields.has(anchor.sourceField)) {
      throw new TypeError(
        `Mutation tool ${value.name} anchor ${anchor.field} has an unknown source ${anchor.sourceField}`,
      );
    }

    if (
      !Array.isArray(anchor.kinds) ||
      anchor.kinds.length === 0 ||
      anchor.kinds.some((kind) => typeof kind !== "string" || kind.trim().length === 0)
    ) {
      throw new TypeError(
        `Mutation tool ${value.name} anchor ${anchor.field} must accept non-empty kinds`,
      );
    }

    if (new Set(anchor.kinds).size !== anchor.kinds.length) {
      throw new TypeError(
        `Mutation tool ${value.name} anchor ${anchor.field} declares duplicate kinds`,
      );
    }

    if (
      anchor.nonAnchorValues !== undefined &&
      (anchor.nonAnchorValues.length === 0 ||
        anchor.nonAnchorValues.some((item) => typeof item !== "string" || item.length === 0))
    ) {
      throw new TypeError(
        `Mutation tool ${value.name} anchor ${anchor.field} must declare non-empty non-anchor values`,
      );
    }

    if (
      anchor.nonAnchorValues !== undefined &&
      new Set(anchor.nonAnchorValues).size !== anchor.nonAnchorValues.length
    ) {
      throw new TypeError(
        `Mutation tool ${value.name} anchor ${anchor.field} declares duplicate non-anchor values`,
      );
    }

    if (anchorFields.has(anchor.field)) {
      throw new TypeError(
        `Mutation tool ${value.name} declares anchor ${anchor.field} more than once`,
      );
    }

    anchorFields.add(anchor.field);
  }

  for (const field of value.pair ?? []) {
    if (!anchorFields.has(field)) {
      throw new TypeError(`Mutation tool ${value.name} pair field ${field} is not an anchor`);
    }
  }
}

export function mutationSource(
  registration: AnyTextMutationToolRegistration,
  parameters: Readonly<Record<string, unknown>>,
): string {
  const value = parameters[registration.source.field];
  return typeof value === "string" ? value : "";
}

function schemaProperties(schema: TSchema, name: string): Readonly<Record<string, unknown>> {
  const properties = (schema as { readonly properties?: unknown }).properties;

  if (typeof properties !== "object" || properties === null) {
    throw new TypeError(`Mutation tool ${name} parameters must be an object schema`);
  }

  return properties as Readonly<Record<string, unknown>>;
}

function assertProperty(
  properties: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): void {
  if (typeof field !== "string" || field.length === 0 || !(field in properties)) {
    throw new TypeError(`${label} field ${field} is not declared by its schema`);
  }
}
