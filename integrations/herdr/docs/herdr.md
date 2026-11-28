# Herdr agents

Use resources to read, search, message and close Herdr agents. Three tools start them, and each agent has an owner:

- `replicate`: a copy of you for a part of your own task that needs your context. You own it.
- `subagent`: a fresh agent for side work that does not need your context, such as research, a search or an isolated task. You own it.
- `agent` (deferred, in the `Herdr` namespace): an independent agent for the user, at the user's request or as the orchestrator of a series of tasks the user gave you. The user owns it.

You follow your replicas and sub-agents, answer them and close them. Close other agents only when the user asks.

## Profiles

Read `herdr:profiles` for the user's workflow profiles: each one's id, name, model, thinking level, fallback model and a description of when to use it. Choose the profile for a sub-agent or an agent from it. The user adds, changes and removes profiles in Herdr App's Workflow settings; each read shows the current ones. `herdr:profiles` cannot be written or deleted.

## Addresses

Read `herdr:` to list Pi agents. Use a terminal address from that list, such as `herdr:workstation/t7`, for its status and latest timeline. Names are display labels and do not select a terminal.

The timeline starts at the last assistant reply and includes subsequent reasoning and calls. Calls marked `(running)` or `(failed)` describe their current state. Tool results appear in history only. An unchanged reply is replaced with a short notice on a repeated read. Reloading Pi clears this per-session cursor.

Statuses are `exited`, `waiting` for the user's answer, `working`, `error`, and `idle`, in that priority. A waiting read includes the question and options. A recorded error remains visible with its timeline.

Agent lists and list searches use the same status words. Herdr's `blocked` maps to `waiting` and `done` maps to `idle`. An open dialog can keep a timeline waiting while the agent works in the background; an untitled dialog asks you to answer in Pi. Codemode calls omit their scripts from the compact timeline; read history for their full arguments.

## Budget

The `herdr-read-budget` IDE setting defaults to 3000 characters and accepts integers from 500 to 20000. Use `views: ["budget:1000"]` to override it for one agent read. Idle timelines drop calls and reasoning before shortening the reply. Working timelines shorten the older reply first. Shortened text retains both ends and reports the cut count. The status, question and error fields remain present; an oversized question or error also keeps both ends.

## History

Search `herdr:<terminal>` or `herdr:<terminal>/history` with a literal substring. Search covers the active session branch, including complete tool results, and returns newest matches first. Regex, whole-word and multiline modes are unsupported. The search is a bounded snapshot and does not claim complete coverage.

Read `herdr:<terminal>/history` for the last 20 items. One numbered line is one history item. To open a match, pass its line number as `offset`; `limit` selects up to 50 items starting there. Read earlier pages with an earlier offset. History and search do not authorize sending messages or advance the reply cursor.

## Messages

Read the agent directly in this Pi session before writing a plain text message to `herdr:<terminal>`. Your own replicas and sub-agents need no prior read. The extension checks the identity it read without exposing a PID or session. If the agent changed, read it again before sending. A waiting agent and an agent still starting refuse messages.

Messages use steering: they arrive after the recipient's current tool calls and before its next model request. An idle recipient starts immediately. Check a failed send's effect; never retry an unknown delivery automatically.

## Waiting

`wait_for_agents` waits until agents stop working: each is idle, waiting for the user, in error or exited. Find it through `tool_search`. Pass one address or a list as `path`. One result covers all listed agents and holds each agent's timeline, as a read does, with the read budget shared between them. It counts as a read for a later write.

Calling it right after a write to an idle agent waits for that agent's reply. An agent also stops to compact, teleport or reload Pi; call the wait again for it when its timeline shows such a pause.

By default the call waits. A new message to you during the wait moves it to the background. With `background: true` the call returns at once. A background result arrives as a message and wakes you when you are idle. Stopping your turn does not cancel background waits; reloading Pi, switching sessions or moving in the session tree does.

## Replicas

`replicate({name, task})` copies your current session and starts the copy in a new tab of your space, with the same model, thinking level and directory. The copy receives a task message: it is a replica, completes only its assignment, changes only the files the assignment covers, does not commit or change Git state, does not ask the user, and stops with a final message about what it did, the files it changed and what is left. The tool returns the replica's address, such as `herdr:workstation/t9`.

There is no worktree, branch or automatic join: the replica's changes appear in your directory as it makes them. Give each replica that changes files its own area, and commit the combined result yourself after checking it.

Each time the replica stops (idle, waiting, in error or exited), its timeline arrives as a message, as a background `wait_for_agents` result does, and wakes you when you are idle. The replica's inherited conversation is not reported, only what it does after the copy. Messages keep arriving after every new stop until you close the replica or it exits, also after you reload Pi. A replica that does not start answering within three minutes, or that exits, is reported once as exited.

Write to the replica to answer its question or steer it, without reading it first. A write or delete right after the launch can fail with `HERDR_REPLICA_STARTING` while the replica's Pi starts; try again shortly. Close the replica with `delete` once its work is done and checked; you get no further messages about it. A stop notice also says that when nothing significant happened and the agent keeps working, you stay silent and end your turn without a message.

A replica can replicate and start sub-agents too; they report to it, not to you. A copy does not follow the replicas of the session it was copied from. Nesting stops two levels below the agent the user started: a replica or sub-agent of a replica or sub-agent gets `HERDR_NESTING_LIMIT` and does the work itself. The number of agents running at the same time is not limited.

`replicate` fails without starting anything with `HERDR_UNAVAILABLE` outside a Herdr terminal, `HERDR_REPLICATE_UNSUPPORTED` when Herdr App is too old (update it and reload Pi), `HERDR_NESTING_LIMIT` past the nesting depth, `HERDR_REPLICATE_REFUSED` for launch input Herdr rejects, `HERDR_REPLICATE_UNSAVED` in a session that is not saved, and `HERDR_REPLICATE_NO_MODEL` without a selected model. `HERDR_REPLICATE_FAILED` and `HERDR_INVALID_REPLY` have an unknown effect: read `herdr:` before replicating again, because the replica may be running.

## Sub-agents

`subagent({name, task, profile, folder?})` starts a fresh Pi in a new tab of your space with the profile's model and thinking level, in `folder` (default: your directory). It does not see your conversation, so write a task that stands alone. Its first message tells it that it is a sub-agent, completes only its assignment, does not ask the user, and stops with a final message about the result, the files it changed and what is left. In your directory, or a folder that holds it or lies inside it, it also changes only the files its assignment covers and does not commit or change Git state unless the assignment says so.

The call returns once the sub-agent answered for the first time; a profile's fallback model starts it when the primary fails at startup. You follow it as a replica: every new stop arrives as a message, you write to it without a read and close it with `delete`, also after you reload Pi.

`subagent` fails without starting anything with `HERDR_UNKNOWN_PROFILE` (read `herdr:profiles`), `HERDR_NESTING_LIMIT`, `HERDR_SUBAGENT_UNSUPPORTED` when Herdr App is too old, `HERDR_INVALID_FOLDER` and `HERDR_SUBAGENT_REFUSED`. `HERDR_SUBAGENT_NOT_STARTED` means its tab opened but its model failed or it exited: read it for the error and close it with `delete`. `HERDR_SUBAGENT_FAILED` has an unknown effect: read `herdr:` before starting it again.

## Closing

`delete({path: "herdr:<terminal>"})` ends that Pi and closes its tab; the space closes with its last tab. Read the agent in this session first, as for a write, unless it is your replica or sub-agent; a `wait_for_agents` result counts. A refused delete leaves the agent running: `HERDR_READ_FIRST` without a read, `HERDR_STALE_TARGET` after its Pi or session changed (read it again), `HERDR_DELETE_SELF` for your own terminal, `HERDR_DELETE_SPLIT_TAB` for a tab that holds other panes, `HERDR_UNKNOWN_AGENT` when the terminal is gone, and `HERDR_DELETE_UNSUPPORTED` when Herdr App is too old and needs an update and a Pi reload. `HERDR_DELETE_FAILED` has an unknown effect: read `herdr:` before retrying. Close agents you started for yourself, such as temporary test agents, once you no longer need them, and agents the user asks you to close. Agents started for the user's tasks stay open until the user decides.

`HERDR_NOT_SUBMITTED` means the App request had no effect. The queue may be full: wait for other Herdr calls to finish, then retry. With an older App, this error can also mean recovery is unavailable; update the App if waiting does not help. `HERDR_RECOVERY_UNSUPPORTED` means the App needs an update for durable recovery. `HERDR_RECOVERY_STORAGE` means the recovery journal or receipt could not be recorded: check saved outcomes, storage permissions and available space before retrying. `HERDR_OUTCOME_UNKNOWN` means the App may have performed the request. Inspect its effects before retrying a mutation; a read-only request is safe to retry.

If Herdr is unavailable, run Pi in a Herdr terminal with a current App and reload Pi. Data comes from the target Pi's authenticated socket. There is no terminal-screen fallback.
