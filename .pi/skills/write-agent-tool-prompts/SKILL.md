---
name: write-agent-tool-prompts
description: Write or revise agent-facing tool prompt snippets, prompt guidelines, tool descriptions, and generated system-prompt text. Use whenever work changes how tools or their capabilities are presented to the model.
compatibility: Requires access to the tool implementation and the generated effective system prompt.
---

# Write agent tool prompts

Treat every agent-facing sentence as part of the tool's behavior.

## Write every behavioral rule as an imperative

Use direct verbs: Use, Read, Select, Submit, Keep, Check, Omit. State the condition when an action applies. This is the single style for behavioral rules in descriptions, parameter guidance and guidelines.

- Write `Use an available anchor when it selects the intended text`, not `Prefer an available anchor`.
- Write `Combine views when both annotations are needed`, not `You can combine views`.
- Write `Omit end when start selects the complete fragment`, not `You may omit end`.
- Write `Submit independent mutations together`, not `Independent mutations can share a block`.
- Write `Check each result and retry only unapplied changes`, not a vague suggestion to check the batch.

Keep conditions precise. An imperative does not make every available action mandatory: `Use AST when locating declarations in a large file` does not mean every read needs AST. Preserve optional parameters, supported alternatives and safety boundaries.

State facts as facts: defaults, accepted values, limits, effects and result formats. Keep `end is optional` declarative. Replace weak behavioral language, not every occurrence of a modal word mechanically.

## Keep prompt layers separate

### Available tools

Use promptSnippet as a short capability index. Keep it to one distinguishing phrase. Do not put parameter contracts or workflows there.

### Tool descriptions and schemas

Schemas own what the tool does: callable inputs, defaults, limits, effects and errors. Begin each IDE-owned top-level schema description with `Use <tool> to ...` and state its operation. Keep use cases and recommendations about choosing neighboring tools out of that description. Preserve factual references needed to use returned resources or anchors.

Place parameter-specific instructions beside that parameter. Use direct instructions with explicit conditions. Preserve the full callable contract without implementation jargon. Do not move required parameter semantics into guidelines or the capability index.

### Guidelines

Guidelines exclusively own when and how to choose or combine tools and cross-tool workflows. Use imperatives for source selection, grouping independent calls and recovery from partial success. Keep tool effects, input defaults, limits and errors in schemas. Keep each rule general enough for ordinary project work; keep benchmark names, fixture patterns and scoring goals out of prompts.

State each semantic contract once. When text appears in more than one layer, keep it only in the owning layer unless the second sentence adds a distinct workflow decision.

## Preserve conceptual boundaries

Distinguish the operation from its selector: edits change content, while anchors locate it. Distinguish source from view: path selects content, views annotate it. Use public parameter names where needed and plain language elsewhere.

## Review each iteration

1. Read the implementation and identify the behavior the wording promises.
2. Separate facts from behavioral rules. Express every rule as a direct, conditional instruction.
3. Check supported capabilities against the implementation and executable tests. Preserve useful contracts while removing duplicates.
4. Capture the effective system prompt and tool schemas from the real configured Pi runtime.
5. Read the complete captured prompt and every schema after each iteration. Judge them as instructions an agent must act on, not isolated source strings.
6. Check that each tool explains when to use it, parameters match runtime behavior, and workflow rules reached the model.
7. Keep correctness and tool-choice outcomes separate in experiments. Retain every attempt; use the eval repository's repeat-confirmation rules before claiming improvement.

Keep historical snapshots as evidence. Generate a fresh review artifact instead of silently replacing the historical baseline.
