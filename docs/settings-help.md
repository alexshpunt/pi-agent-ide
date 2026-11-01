# Agent IDE settings

Open `/agent-ide-settings` and choose where to save changes: **Project** or **Global**. For this page inside Pi, run `/agent-ide-help`. It opens a local, scrollable window; Esc closes it. Reading help does not add messages to your session or send anything to the model.

## Choose the right tab

- **Features** controls which built-in capabilities load. Disable a module when you do not want the agent to use it. The description shows its effective state and dependency restrictions.
- **Behavior** changes how capabilities work, including the capability preset and automatic checks. Read the selected item's description before changing it.
- **UI** changes what you see: tool output, edit previews, diagnostic notices and active-process cards. Hiding output does not disable a tool or reduce the result the agent receives.

Tab switches tabs. Type to filter the current list, then use Enter to change a value. Edits are staged until you save.

## Save in the right place

Choose **Project** for this repository or **Global** for your usual defaults across projects. Project values override Global values for individual behavior flags and presentation preferences. **Default** removes the override in the selected scope; it restores inheritance, not necessarily the built-in value.

Modules have stricter rules: a module disabled in either scope stays off. Enabling it in Project does not undo a Global disable. Disabled dependencies and the selected preset can also restrict capabilities; check the effective state shown in the menu.

Press **Ctrl+S** to save. On **Esc**, if there are unsaved changes, choose **Yes** to save them or **No** to discard them. Settings that support live updates take effect on save. The menu offers a reload only for effective changes that need one. Reload can reset in-memory extension state.

## Reduce noise or inspect details

**Show tool results from Codemode** defaults to **Off**. It hides extra successful Agent IDE panels, while errors stay visible. Turn it **On** to show those panels using each tool's own Read, Search, terminal or diff presentation setting. It does not change Codemode's JavaScript, output or other tools.

Use Pi's tool-output expansion shortcut (**Ctrl+O** by default) to inspect full retained IDE panels temporarily, even when this setting is Off. Read, Search, terminal and diff presentation have separate choices. Start with Compact; change only the output that gets in your way.

## Change sensitive options deliberately

**Jev code review** sends saved code fragments to a connected review provider. **Skip automatic post-processing** skips automatic formatting and diagnostics after edits; explicit diagnostic reads still work.

## Ask the agent to configure it

Ask: “Explain how to use and configure Pi Agent IDE,” or “Configure Pi Agent IDE for my workflow.” The agent can explain the relevant settings without changing them. Before configuring it, the agent asks whether to save changes for this project or globally unless you already specified the scope.

For a specific change, try: “Show tool results from Codemode for this project only; leave other settings unchanged.” You can also use `/skill:configure-agent-ide` with your request. Reload after saving changes.

For development only, enable **Developer mode** in Behavior and reload to make `/agent-ide-tip` available. It shows the startup setup hint again without resetting its one-time state or sending its text to the model. Developer mode defaults to Off; normal startup hints do not depend on it.

See [Configuration](./configuration.md) for storage paths, command-line overrides and deeper setup details.
