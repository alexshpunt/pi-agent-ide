# Selected anti-slop rules

This directory vendors seven rules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).

Enabled rules:

- `no-chained-type-assertions`
- `no-module-mocking`
- `no-object-parameters`
- `no-reflect-apply`
- `no-reflect-get`
- `no-unknown-type-aliases`
- `no-widen-then-assert`

The rules are vendored so we can review and maintain them with the repository. The upstream MIT license is in `LICENSE`.

We intentionally did not enable rules that broadly reject `unknown`, runtime boundary checks, conditional object spreads, explicit public contracts, or undocumented single assertions. Those patterns are valid in this project's protocol and integration code.
