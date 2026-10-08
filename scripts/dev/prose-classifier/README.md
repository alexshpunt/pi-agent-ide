# Jev prose-coupling experiment

This is a manual classifier audit, not a lint rule or CI gate. It checks one
selected assertion at a time with the full test file as context. It does not
run those tests, change their expectations, or call a chat model.

## Run

```sh
# Prepare and validate source locations without model requests.
pnpm exec oxnode scripts/dev/prose-classifier/audit.ts
# Send the 50 contexts to authenticated TypeSafe Jev through Pi's ModelRuntime.
pnpm exec oxnode scripts/dev/prose-classifier/audit.ts --live
# Check input isolation and metric calculations without a model.
pnpm exec vitest run scripts/dev/prose-classifier.test.ts
```

The live command sends repository test source to the configured TypeSafe
provider using existing Pi credentials. It fails if Jev is unavailable. No
separate client, API key, Pi session, or extension changes are needed.

Inputs and raw results are saved under `.tmp/prose-classifier/`. Cached
successful responses use a hash of provider, model ID, question definitions,
and the complete supplied context. Provider failures stop the run, save
partial results, and are not retried automatically or reported as clean.

## Reference sample

`cases.json` contains 50 selected assertion locations: 40 from repository
tests and 10 fabricated examples. They include all 15 prompt/document
candidates from the custom lint scan, 25 broader candidates, and synthetic
checks that distinguish prompt wording from fixture preservation, protocol
bytes, YAML decoding, and missing context.

Labels and rationales were written by the coding agent before the first model
request. They are provisional judgements, not user-approved or independent
human ground truth. The three labels are:

- `prose`: editable production sentence wording is being pinned.
- `contract`: a non-wording contract is being checked, such as fixture
  preservation, technical syntax, metadata, or an error category. This is not
  approval of the test's overall quality.
- `unknown`: the available evidence does not settle the boundary.

The model receives the target assertion, file path, line, and full test source.
It does not receive the reference label, rationale, split, or other cases'
answers. Whole source includes the surrounding tests and local helpers, but
imported implementations and product requirements are not fetched. This is a
known context limitation, not evidence that every unknown case is defective.

The source bound is 60,000 characters; larger files fail rather than being
silently truncated. If a stored line no longer locates one expectation, the
preparation step fails before any model call. Review and relabel locations
when the source changes.

## Evaluation boundary

The 14 development cases and 36 holdout cases are grouped by source file.
Related assertions from one real file do not cross the split. Synthetic
cases are all holdout and are reported separately from repository cases.
The prompt and labels are frozen before the first run; do not silently tune
against holdout answers and keep calling the same set a fresh holdout.

This is a selected stress sample, not a random sample of all tests. Several
assertions share one enclosing test. Report counts as assertions, not tests,
and do not extrapolate an error rate to the repository.

The report includes three-way agreement, abstentions, errors, a confusion
matrix, and prose precision/recall against the provisional labels. Precision
counts every prose flag not labelled prose as disagreement, including
ambiguous reference cases. Recall includes abstentions and errors as misses.
No probability threshold is selected and model confidence is not assumed to
be calibrated.

A repeat with the same inputs uses cache and does not measure live stability.
The provider's `jev-latest` alias can change its underlying model without a
new ID; old cache results remain a historical snapshot, not current evidence.

## Results

The first run used `typesafe/jev-latest`: 50 live requests, no cached responses,
14.7 seconds for the request loop, and 98,233 reported tokens. The direct
provider's catalog reports zero cost; this is not a measured billing amount.

| Group              | Agreement | Prose found / reference prose | Flags | Unknown replies |
| ------------------ | --------: | ----------------------------: | ----: | --------------: |
| All                |     34/50 |                         15/15 |    30 |               0 |
| Development        |      8/14 |                           5/5 |    11 |               0 |
| Holdout            |     26/36 |                         10/10 |    19 |               0 |
| Repository         |     26/40 |                         10/10 |    23 |               0 |
| Synthetic          |      8/10 |                           5/5 |     7 |               0 |
| Repository holdout |     18/26 |                           5/5 |    12 |               0 |

All 15 reference prose cases were flagged, but so were eight cases labelled
contract and seven labelled unknown. The other unknown case was called
contract. All 50 requests succeeded. All-sample precision is 50% under the
conservative reference scoring; holdout precision is 52.6%. This is not a
population accuracy estimate, and the reference judgements may be disputed.

Useful detections include the five known instruction sentence pins and
full explanatory/guidance sentences embedded in result objects. The fabricated
prompt getter and expected-variable cases were detected too.

Concrete mistakes include the YAML fixture-folding test in `config.test.ts:5`
and forwarding a fixture rule description in `reviewer.test.ts:71`. Both were
called prose coupling despite the text being caller-authored fixture data.
The three synthetic preservation/protocol/YAML cases were correctly retained,
so their clean results alone would have overstated real-world robustness.

The eight disagreements with contract labels also include two capture-enabled
metadata checks, a tool-label check, two short diagnostic categories, and a
technical byte-continuation action. Some of these boundaries need user review;
model disagreement alone does not settle them.

None of the eight ambiguous reference cases received unknown. In particular,
Jev flagged an opaque function without its implementation and a UI label
without a stated product contract. A confident choice is not proof that the
context was sufficient. Probabilities and confidence are saved in the raw
report; they are not a written explanation of the model's reasoning.

Conclusion: this first pass catches the intended leads but still makes clear
fixture mistakes and does not abstain where expected. Keep it advisory. A
future experiment could separate source provenance, exact-text necessity,
and context sufficiency into focused questions, and supply relevant imported
implementations. It would need a new held-out sample rather than tuning these
results into a claimed validation success. Neither this experiment nor its
metrics authorize automatic enforcement or test edits.

Before the first call, the frozen case file had SHA-256
`51d8de8fd3d2e84c430381b20c1b2c591e1231d3f54f998b507854715f84a1cc`.
The runner/question definition file had SHA-256
`93db501bfcddd946b446d6c423c50dd2fb68aa073ed170edb5c009b2e7524ce0`.
No question or label was changed after inspecting this run.
