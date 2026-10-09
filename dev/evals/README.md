# Local and SSH agent comparison

`ssh-parity.config.ts` runs the same three tasks with the same model, tools and instructions:

- edit a file, reject one real external change, reread and preserve its comment;
- copy binary bytes to the application and back without changing the original;
- use a small Python service, check its output and exit 0, then delete its terminal session.

Each SSH trial starts its own private fixture. The suite waits for fixture cleanup even when validation fails. It does not install tools, change global settings or use a user's SSH keys. Missing output files score a failure; they do not stop the next trial.

Run from the repository root. Set `PI_EVAL_CLI` to an existing `pi-coding-agent-eval` CLI entrypoint. The evaluator is a development facility, not a production dependency.

```sh
pnpm exec esbuild dev/evals/ssh-parity.config.ts --bundle --platform=node --format=esm --packages=external --outfile=.tmp/ssh-parity-eval/config.mjs
PI_SSH_EVAL_SCRIPTED=1 node "$PI_EVAL_CLI" run ssh-parity contracts --config .tmp/ssh-parity-eval/config.mjs --agent-profiles local,ssh --model scripted/scripted-model --thinking off --run-id scripted-check
```

The scripted run uses actual Pi processes and tools, not fabricated results. File recovery takes another agent turn because a failed deferred commit stops its native script. Service checks exercise stdin and the ordinary shell Read resource.

For a real comparison, omit `PI_SSH_EVAL_SCRIPTED` and use the same model and thinking level for both profiles. Only do this when a live model evaluation is authorized.

```sh
node "$PI_EVAL_CLI" run ssh-parity contracts --config .tmp/ssh-parity-eval/config.mjs --agent-profiles local,ssh --model openai-codex/gpt-6.1-sol --thinking low --attempts 1 --run-id live-check
```

Results go under `.tmp/ssh-parity-eval/results/`. Record correctness, assistant turns, tool errors, model-visible tool context bytes and the ordered recovery trajectory. One paired attempt per task is a small contract sample, not a performance benchmark.

## Check recorded evidence

The first real-provider run exposed two validator assumptions: `providerRequests` only covered scripted calls, and an interactive service reported completion through structured shell Read text rather than Bash metadata. `audit-ssh-parity.ts` checks actual assistant-start events and completed shell headers, output and exact session deletion. It writes a separate audited report and leaves historical scores untouched.

```sh
pnpm exec esbuild dev/evals/audit-ssh-parity.ts --bundle --platform=node --format=esm --packages=external --outfile=.tmp/ssh-parity-eval/audit.mjs
node .tmp/ssh-parity-eval/audit.mjs .tmp/ssh-parity-eval/results/live-check
PI_EVAL_CLI="$PI_EVAL_CLI" pnpm exec vitest run --config vitest.integration.config.mjs tests/integration/ssh-parity-eval.integration.test.ts
```

The integration test runs both profiles through the real evaluator, requires the conflict and successful recovery, and checks recorded context and rounds. Without an explicitly configured evaluator it is skipped, not counted as positive evidence.
