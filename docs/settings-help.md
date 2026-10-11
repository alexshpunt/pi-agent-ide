# Agent IDE settings

Open `/agent-ide-settings` and choose where to save changes: **Project** or **Global**. For this page inside Pi, run `/agent-ide-help`. It opens a local, scrollable window; Esc closes it. Reading help does not add messages to your session or send anything to the model.

## Choose the right tab

- **Features** controls which built-in capabilities load. Disable a module when you do not want the agent to use it. The description shows its effective state and dependency restrictions.
- **Behavior** changes how capabilities work, including the capability preset, automatic checks and capture permissions. Read the selected item's description before changing it.
- **UI** changes what you see: tool output, edit previews, diagnostic notices and active-process cards. Hiding output does not disable a tool or reduce the result the agent receives.

Tab switches tabs. Type to filter the current list, then use Enter to change a value. Edits are staged until you save.

## Save in the right place

Choose **Project** for this repository or **Global** for your usual defaults across projects. Project values override Global values for individual behavior flags and presentation preferences. **Default** removes the override in the selected scope; it restores inheritance, not necessarily the built-in value.

Modules have stricter rules: a module disabled in either scope stays off. Enabling it in Project does not undo a Global disable. Disabled dependencies and the selected preset can also restrict capabilities; check the effective state shown in the menu.

Press **Ctrl+S** to save or **Esc** to cancel. Saving offers a reload. If you decline, the saved choices apply on the next reload or startup. Reload can reset in-memory extension state, so finish any work that depends on it first.

## Reduce noise or inspect details

Codemode defaults to **Compact**: native call summaries and errors remain visible, while collapsed scripts and successful output bodies stay hidden. Choose **Detailed** for script and output previews. Use Pi's tool-output expansion shortcut (**Ctrl+O** by default) to inspect full details temporarily without changing the saved preference.

Read, Search, terminal and diff presentation have separate choices. Start with Compact; change only the output that gets in your way.

## Change sensitive options deliberately

Keep **Capture arbitrary windows** and **Capture full displays** off unless the agent may inspect other apps or your whole desktop. **Jev code review** sends saved code fragments to a connected review provider. **Skip automatic post-processing** skips automatic formatting and diagnostics after edits; explicit diagnostic reads still work.

## Ask the agent to configure it

For example: “Set Codemode to Detailed for this project only; leave other settings unchanged.” You can also use `/skill:configure-agent-ide` with that request. Say Project or Global, and reload after the change.

See [Configuration](./configuration.md) for storage paths, command-line overrides and deeper setup details.
