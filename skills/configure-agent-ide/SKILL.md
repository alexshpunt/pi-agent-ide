---
name: configure-agent-ide
description: Inspect and safely change Pi Agent IDE settings when the user asks to configure the IDE, enable or disable its modules or behavior, change output presentation, or restore defaults. Use for requests such as detailed Codemode, compact output, or Project/Global IDE setup. Not for Pi model selection, credentials, package installation, or unrelated extension settings.
---

# Configure Agent IDE

## Discover supported settings

Read `docs:ide-settings` before choosing IDs or values. It is generated from the same registrations as the settings menu. It lists supported choices and defaults, not the user's current configuration. Search within that guide when locating a setting; read the relevant context before changing it.

If the docs provider is unavailable, read `../../docs/configuration.md` relative to this skill directory. For exact current IDs, values and defaults, read only the relevant installed registrations: `../../src/composite/preferences.ts`, `../../src/composite/builtin-extensions.ts`, `../../src/composite/presets.ts`, or flag registrations in `../../src/pi-agent-ide.ts`. Scope resolution and merging are in `../../src/composite/extensions-config.ts`. Treat these package files as read-only. If supported information is still unavailable, explain the blocker and offer `/agent-ide-settings`; do not guess or enable documentation modules just to get a guide.

## Inspect the requested scope

Resolve Global and Project paths using the guide's contract and the actual working directory, home and `PI_CODING_AGENT_DIR`. Do not assume the default global directory when the variable is set. Read both files; a missing file means no override, while malformed or unreadable configuration is a blocker.

Map the user's request to a registered setting and allowed value. Ask which scope to change if the request does not establish Project or Global. Ask about an ambiguous setting instead of choosing a nearby option. Explain when a higher-priority override, preset, dependency or CLI flag prevents the requested effective state.

Keep saved overrides, inherited defaults and the running session distinct. Removing an override restores inheritance; it is not the same as writing the built-in default. For modules, inspect disable lists in both scopes and preset restrictions before promising an enable.

## Make the smallest authorized change

Use the ordinary file editing tools to change only the requested keys in the chosen IDE configuration file. Re-read before editing, preserve unrelated and unknown fields, and use the registered storage types. Default removes the selected override. Handle legacy flag fields as described in the guide. Do not rewrite a matching configuration just to restyle it.

Do not change Pi's own settings, credentials, package sources, installed code, or another scope to make the result work. Ask before enabling desktop capture, sending code to a review provider, or another security-sensitive opt-in unless the user explicitly requested that exact behavior.

Read the saved file afterward and compare it with the intended change. If a write result is uncertain, inspect before retrying. Do not turn a read error into an empty configuration or replace a malformed file with defaults.

## Report what changed

State the scope, file, setting and saved value, or explain that nothing needed changing. Name any blocker or remaining override. Saved configuration is not proof that the running session changed: offer reload or restart, and verify the effective behavior after an authorized reload before saying it is active.
