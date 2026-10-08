# Optional Jev code review

Jev checks saved edit fragments against your project's own rules. It adds review hints,
not compiler errors. It does not fix code, block edits, or certify that code is correct.

Review and rule capture are separate features. Both are off by default.

## Enable review

Open `/ide` and enable **Jev code review** in Features, or add the flag to
`.pi/pi-agent-ide/extensions.json`:

```json
{
  "flags": {
    "pi-agent-ide-code-review": true,
    "pi-agent-ide-code-review-capture": false
  }
}
```

Reload Pi after changing the file. The corresponding CLI flags use the same names.
The existing global extension settings can also set these flags.

Connect a Jev provider through Pi. The integration uses Pi's native authenticated classifier
runtime. It prefers TypeSafe Jev when available, then another available Jev model.
It does not select a chat model or install a provider.

Enabling review allows the configured provider to receive inspected code and rule descriptions.
With review disabled, no connected Jev, or no enabled rules, no classification runs.

## Define your rules

Create `.pi/pi-agent-ide/code-review.yaml` in the Pi working directory:

```yaml
rules:
  - id: hidden-errors
    description: >
      Do not turn a failed operation into a successful result.
      Explicit recovery that preserves the documented contract is allowed.
  - id: example-disabled
    description: Explain one concrete expectation here.
    enabled: false
```

These examples are not built-in policy. Write your own expectations in natural language.
Describe a visible violation and allowed exceptions. Avoid rules that need the whole
repository or undocumented requirements to judge.

IDs start with a lowercase letter and contain lowercase letters, numbers and hyphens.
IDs are unique and limited to 64 characters. Descriptions are limited to 2048 characters.
The file accepts at most 32 rules and 64 KiB of text. Unknown fields, duplicate IDs,
YAML aliases and invalid YAML are rejected. An empty `rules: []` means no checks.
Rules reload for each review; editing the rule file itself does not trigger review.

## What gets checked

Review observes saved text-editor changes, including final batched writes and undo.
Each request contains one complete diff hunk with three surrounding lines on each side,
and all enabled rules. Nearby changes may share a hunk. Removed lines are included.

Writes and formatting do not wait for review. Edits to the same file are combined over
300 milliseconds. Classifier requests run sequentially and each review has a 15-second
request timeout. New edits cancel previous work; replies for a different saved snapshot
are discarded, including after external writes.

Automatic review skips changes above these bounds with an unavailable notice:
300,000 combined before/after characters, 16 hunks, or 12,000 characters in a hunk.
It never presents a clipped fragment as a complete review.

## Read the feedback

Jev chooses violation, clear, or insufficient context for each rule.
Violations are reported only when their classification probability is at least 80%.
That number is a model score, not a measured probability that the code is wrong.

The background message names the file, snapshot, provider/model, rule and inspected diff.
Expand it to read the evidence. Findings can wake an idle agent, like ordinary diagnostics.
Unavailable and insufficient-context notices do not start a new turn by themselves.

No generated explanation is attributed to Jev. No findings does not mean the code passed
a complete review. Provider failures never undo edits or suppress regular diagnostics.

Reported classifier tokens and catalog cost are shown in feedback when available.
Background calls are not tool results, so Pi does not automatically add them to tool-result
cost totals. Do not use the session footer as a budget limit for this feature.

## Capture rules from your reviews

Enable **Capture code-review rules** separately. Pi then tells the agent to use the shipped
`capture-code-review-rule` skill after reusable code-review feedback.

The skill proposes a general rule, checks for duplicates and waits for confirmation before
saving it. Strong wording or anger alone is not a rule. It never enables review, and it can
capture rules without a Jev connection. With capture disabled it does not act.

The skill is agent guidance, not a guaranteed automatic listener or a write-permission gate.
Inspect proposed rules before accepting them.
