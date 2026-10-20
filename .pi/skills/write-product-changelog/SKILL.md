---
name: write-product-changelog
description: Write, edit, or audit a product CHANGELOG or release notes. Use during release preparation and whenever the user asks to clean up changelog entries. Include only changes to the product, not work on its repository, tests, benchmarks, or release process.
---

# Write a product changelog

A changelog tells users what changed in the product: features, fixes, improvements, changed defaults, compatibility changes, and important limitations. It is not a development log.

## Select entries

Read the existing changelog and compare the product with the previous released version. Use the actual source changes, not commit titles alone. Explain what a user or an agent using the installed product can now do, what works better, or what behavior changed.

Exclude repository cleanup, research, Tasks and PRs, code-review workflow, test coverage and fixtures, CI jobs and timing, benchmarks and evaluation results, evidence retention, developer hooks, release automation, publication approvals, tags, and synchronization. Do not add a Maintenance or Verification section to smuggle these changes into the changelog.

A product installation fix, security fix, or compatibility change belongs when it changes the user's experience. A packaging validation check or publishing workflow change does not. An agent-facing tool or shipped skill is part of the product; an internal skill for maintaining the repository is not.

For a mixed entry, retain only the product change. For a change that has no product effect, delete the entry rather than rephrasing internal work as an improvement. Do not move rejected entries into another repository report.

## Write and check

- Use plain English and concrete behavior. State important defaults and opt-ins.
- Group related product changes under useful headings. Remove empty headings.
- Keep version numbers, dates, and genuine historical product changes. Do not replace old behavior with current behavior when auditing earlier releases.
- Do not claim that added tests or a successful benchmark introduced a product capability.
- Check every entry with: “What changed for someone using the product?” If the answer is only how we develop, check, or release it, leave it out.
- When asked to audit the whole changelog, inspect every version, not just the upcoming release.

Follow the repository's release workflow for generated version sections and metadata. Review the actual resulting changelog, obtain any required approval of its current head, and keep detailed verification evidence on the Task rather than in Git. Do not write tests or launch models to assert compliance with this skill's wording.
