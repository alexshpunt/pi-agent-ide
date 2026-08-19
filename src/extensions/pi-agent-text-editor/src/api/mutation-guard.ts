import type { TextEditIntent } from "#src/api/edit-completion.js";
import type { AppliedTextChange } from "#src/core/text-change-engine.js";
import type { TextDocument } from "pi-agent-text";

export interface TextMutationPlanResource
{
    readonly source: string;
    readonly existed: boolean;
    readonly before: TextDocument;
    readonly after: TextDocument;
    readonly changes: readonly AppliedTextChange[];
}

export interface TextMutationPlan
{
    readonly resources: readonly TextMutationPlanResource[];
}

export interface TextMutationGuardRejection
{
    readonly code: string;
    readonly reason: string;
    readonly message: string;
    readonly annotation?: Readonly<Record<string, unknown>>;
    readonly effect: "not-applied";
}

export type TextMutationGuardOutcome =
    | { readonly kind: "accepted"; }
    | { readonly kind: "rejected"; readonly rejection: TextMutationGuardRejection; };

export interface TextMutationGuardContext
{
    readonly cwd: string;
    readonly intent?: TextEditIntent;
    readonly signal?: AbortSignal;
}

export interface TextMutationGuardRegistration
{
    readonly id: string;
    readonly guard: (
        plan: TextMutationPlan,
        context: TextMutationGuardContext,
    ) => TextMutationGuardOutcome | Promise<TextMutationGuardOutcome>;
}
