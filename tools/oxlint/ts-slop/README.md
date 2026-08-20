# Selected ts-slop rules

This directory vendors and adapts seven rules from [AugurCognito/ts_slop](https://github.com/AugurCognito/ts_slop) to Oxlint's plugin API.

Enabled rules:

- `no-dual-key-access`
- `no-identity-passthrough`
- `no-non-null-assertion-chain`
- `no-reduce-as-map`
- `no-redundant-boolean-if`
- `no-sort-for-extremum`
- `no-string-concat-in-reduce`

The upstream package uses `@typescript-eslint/utils`. These copies use the existing `@oxlint/plugins` bridge so the repository does not regain ESLint, typescript-eslint, or the TypeScript JavaScript API.

Related checks use native Oxlint rules where possible:

- `typescript/no-explicit-any`
- `typescript/ban-ts-comment`
- `eslint/no-useless-catch`

We intentionally excluded broad catch and fallback rules because this project has explicit best-effort probes, cleanup, and resolver fallback contracts. We also excluded subjective comment rules and rules with unsafe or inaccurate transformations.

The upstream MIT license is in `LICENSE`.
