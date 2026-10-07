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

## Put each detail where the agent needs it

### Available tools

Use promptSnippet as a short capability index. Keep it to one distinguishing phrase. Do not put parameter contracts or workflows there.

### Tool descriptions

Explain how to use the tool and what it helps the agent do. Begin each IDE-owned description with `Use <tool> to ...`. Keep the description useful for an ordinary call, not a summary of every argument, exception and backend mechanism.

Leave parameter syntax, defaults, units and accepted values in the relevant schema fields. Do not preload output limits, internal bookkeeping or explanations of situations that have not happened.

### Schema fields

Put each argument's calling details beside that argument: accepted forms, defaults, units, constraints and effects needed to make a valid, intentional call. Keep required input information available before the call; progressive disclosure is not a reason to hide it.

Describe supported inputs, not their implementation. Do not repeat field explanations in the tool description, system prompt or unrelated fields.

### System prompt rules

Use general rules for choosing and combining tools. Keep cross-tool workflows here when they guide ordinary work. Do not turn these rules into a catalog of parameters, internal mechanisms or possible failures.

### Progressive disclosure

Explain implementation details and complex cases only when they become relevant. Use the matching guide for a detailed workflow and the actual tool result for a situation the agent has encountered.

If output reaches a limit, explain it in that result and provide the actual continuation offset or saved-output reference. Do not announce the output cap in the initial tool description. If a call fails, explain that failure and its recovery there instead of teaching every error path before the first call.

Give the agent enough information for its next action, not a tour of the internals. State each detail once at the relevant layer unless another occurrence adds a different, necessary instruction.

## Preserve conceptual boundaries

Distinguish the operation from its selector: edits change content, while anchors locate it. Distinguish source from view: path selects content, views annotate it. Use public parameter names where needed and plain language elsewhere.

## Track each tool and state

Create one tool subtask under the prompt-review task. Build its agent-facing finite-state machine (FSM) from the implementation and supported behavior before creating state subtasks. Record each state and the conditions for entering it. Keep independent dimensions, such as warnings and source readiness, separate instead of pretending they are mutually exclusive outcomes.

After building the FSM, create one state subtask under that tool subtask for every identified state. Use real parent-child links so no state is lost between reviews. Keep these task shells limited to the state, its conditions, and two reference fields: `Current agent prompt` and `Tool schema`. Leave both reference fields as `TBD` by default. Do not add proposed wording, fixes or an implementation plan when creating the shells.

Immediately before starting a state subtask, capture the current effective agent prompt and tool schema from the configured runtime and fill its reference fields. Include relevant result guidance for that state. Use this fresh baseline for the review; do not treat an earlier capture as the current interface. Agree the proposed change in chat before applying it. Creating the state backlog does not approve its later rewrites.

## Review each iteration

1. Read the implementation and identify the behavior the wording promises.
2. Put usage in the description, argument details in their schema fields, and situational explanations in progressive guidance. Express behavioral rules as direct, conditional instructions.
3. Check supported capabilities against the implementation and executable tests. Preserve useful contracts while removing duplicates.
4. Capture the effective system prompt and tool schemas from the real configured Pi runtime.
5. Read the complete captured prompt and every schema after each iteration. Judge them as instructions an agent must act on, not isolated source strings.
6. Check that descriptions explain tool use without duplicating fields or anticipating every failure. Check that parameter details match runtime behavior and situational guidance gives the next action when needed.
7. Keep correctness and tool-choice outcomes separate in experiments. Retain every attempt; use the eval repository's repeat-confirmation rules before claiming improvement.

Keep historical snapshots as evidence. Generate a fresh review artifact instead of silently replacing the historical baseline.
