# pi-agent-herdr

Read and search the user's independent Pi agents and send coordination messages through `herdr:` resources in Pi Agent IDE. The `replicate` tool lets an agent copy itself into a new Herdr tab for a parallel part of its task, and `subagent` hands a side track to a fresh agent with a workflow profile; the agent follows both until it closes them. Herdr App's `agent` tool starts independent agents for the user.

## Setup

Run `pnpm install` at the repository root to link the workspace dependencies. Install Pi Agent IDE and add the absolute path to `integrations/herdr` to Pi's `packages` in `settings.json`, then reload Pi. Herdr App must be current and Pi must run in a Herdr terminal. `replicate` needs a Herdr App whose Pi bridge supports `agent.replicate`; `subagent` and `herdr:profiles` need `agent.subagent` and `workflow.get`. Do not load the old `pi-agent-herdr` or `pi-agent-replicate` packages alongside this integration: they register the same tools.

This integration is not published to npm.

## Usage

- `read({path: "herdr:"})` lists agents.
- `read({path: "herdr:workstation/t7"})` shows status and the latest timeline.
- `read({path: "herdr:workstation/t7", views: ["budget:1000"]})` sets a character ceiling.
- `search({path: "herdr:workstation/t7", query: "fixture"})` searches session history.
- `read({path: "herdr:workstation/t7/history", offset: 12, limit: 10})` opens history items.
- `write({path: "herdr:workstation/t7", content: "Please wait before restarting the App."})` sends a steering message after a read.
- `delete({path: "herdr:workstation/t7"})` ends the agent after a read and closes its tab.
- `wait_for_agents({path: ["herdr:workstation/t7", "herdr:workstation/t9"]})` waits until both agents stop working and returns their timelines in one result. Add `background: true` to get the result later as a message. The tool is deferred: agents find it through `tool_search`.
- `replicate({name: "check-auth", task: "Check the auth module and report the risks."})` copies the session into a new tab of the caller's space. Each time the replica stops, its timeline arrives as a message, until the caller closes it with `delete` or it exits. The caller writes to the replica without reading it first.
- `read({path: "herdr:profiles"})` lists the user's workflow profiles with what each is for.
- `subagent({name: "research-tooltips", task: "Find how GPUI shows tooltips and report the API.", profile: "research"})` starts a fresh agent with that profile in a new tab of the caller's space; the caller follows it as a replica.

Replicas and sub-agents nest at most two levels below the agent the user started.

See [the agent guide](docs/herdr.md) for statuses, paging, write guards, replicas and sub-agents.

## Verification

Run `pnpm --filter pi-agent-herdr typecheck` from the repository root to check the package. The tests include real Pi process cases with a deterministic bridge fixture.
