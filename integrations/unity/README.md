# Pi Agent Unity

A Pi extension for working with multiple Unity Editor projects through the Unity CLI's MCP server. It runs independently of Pi Agent IDE and can also add Unity resources to IDE Read and Search.

## Requirements

- Pi with deferred-tool discovery and Node.js. Unity operations also require the Unity CLI.
- The Unity CLI and running Editors must be accessible on the selected machine. Enable the Unity MCP integration in each project: run `unity pipeline install` in the project folder, which adds the Pipeline package (`com.unity.pipeline`), then restart its Editor. Until then the Editor is discovered but every call reports it unreachable.
- Set `PI_UNITY_CLI` or `PI_UNITY_REMOTE_CLI` to select a specific local or remote executable when automatic discovery cannot find it. In WSL this can be a Windows `unity.exe` path. Restart Pi after changing the environment.

Install from the IDE checkout with `pnpm install --frozen-lockfile`, then run `pi install ./integrations/unity --local` from the repository root. Remove it with `pi remove ./integrations/unity --local`. The package can also run without the IDE extension; its SDK dependency remains installed. Installing this package does not change an existing MCP configuration.

The npm release is not published yet. A local candidate can be packed with `pnpm --filter pi-agent-unity pack` and installed in a separate Pi project with its dependencies.

## Use

1. Discover `unity_read`, then read `unity://projects` for registered projects or `unity://editors` for running Editors. These resources return a result per local or configured SSH machine; a machine's error does not hide the other results. Copy a running Editor's `projectPath` exactly as shown.
2. Search `unity://project/<URL-encoded-absolute-project-path>/tools` for words in an operation's name or description. Encode path separators and other reserved characters in the path segment. Search returns matching tool names and resource URIs, not the entire catalog.
3. Read a returned tool URI to inspect its schema. Invoke the operation through `unity_call` with its name, arguments and explicit project path. Search also registers matching individual `unity_<tool-name>` deferred tools when their schemas permit it.

The individual tool schema is taken from the first Editor whose catalog registered that name in the current Pi session. If Editors expose different versions of a tool, inspect the selected project's schema and use `unity_call` for the differing version.

For example, `unity_call` can invoke `scene_get_hierarchy` with `arguments: {}` and an explicit `project`. Review each tool's schema and effects before invoking a mutation. Use native dry-run and confirmation parameters where available. A cancelled, timed-out or disconnected mutation can have taken effect; inspect the Editor before retrying it.

The extension requires exactly one ready main Editor for the requested path. It resolves the project's PID and checks discovery again after connecting and before a call. It does not fall back to the current directory or another project. It launches a separate MCP connection per call so concurrent agents and projects do not share mutable target selection. This cannot make editor state or external operations transactional; an Editor can close or change while a request is in flight.

## CLI setup

The extension installs a missing Unity CLI by itself. The first Unity request that finds no CLI on its machine, local or a configured SSH target, runs Unity's official installer and then continues; no confirmation is asked. Concurrent requests share one installation, and a failed attempt is not repeated for ten minutes. An explicitly configured executable (`PI_UNITY_CLI`, `PI_UNITY_REMOTE_CLI`) is never replaced, and an existing CLI is never overwritten. Set `PI_UNITY_AUTO_INSTALL=0` to turn this off.

| Machine      | What is installed                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux, macOS | `install.sh` runs in a temporary isolated home with agent setup disabled, so no shell profile is changed. The verified executable goes to `~/.local/share/pi-agent-unity/bin/unity`, and the extension finds it even when that directory is not on PATH. |
| Windows      | `install.ps1` runs with agent setup disabled and installs `%LOCALAPPDATA%\Unity\bin\unity.exe`. As the official installer does, it adds that directory to the user PATH and writes its Unity Hub install receipt.                                        |
| WSL          | The Windows CLI is installed the same way through `powershell.exe`, because Editors usually run on Windows.                                                                                                                                              |

Local installation needs only Node.js. An SSH target needs Python 3 on a Linux, macOS or WSL host; SSH to a native Windows host is not supported. The installers are downloaded from `https://unity.com`; `PI_UNITY_INSTALLER_BASE` points them at a mirror. Unity's installers verify the CLI's SHA-256 and support x64 and arm64 on Windows 10 21H1 or newer, macOS 14 or newer, and Linux with glibc 2.34 or newer. On an unsupported system, the discovery error says why nothing was installed and links [Unity's manual instructions](https://docs.unity.com/en-us/unity-cli/use-unity-cli).

If the connection is lost during installation, inspect the selected machine before retrying. Discover `unity_install_cli` to inspect a machine, or to install on demand after interactive confirmation, for example when automatic installation is disabled. A missing CLI and an SSH connection failure are reported separately.

## SSH projects

Configure targets in Pi Agent IDE's SSH settings (`~/.pi/agent/pi-agent-ide/ssh.json` or `.pi/pi-agent-ide/ssh.json` in the current workspace). A project target overrides the global target with the same ID. The target host must be an OpenSSH alias with non-interactive authentication and an already trusted host key. Python 3 is required on the remote Linux host; Unity operations also need the CLI there. The extension uses these settings even when IDE is not loaded.

Read `unity://editors/<target-id>` to discover running Editors on one target. Their `projectPath` values are `ssh://<target-id>/<absolute-path>` references: use one unchanged as the project argument, and URL-encode the entire reference when constructing a catalog URI. `unity://projects/<target-id>` lists registered projects on that machine; its paths are remote filesystem paths, so convert Windows paths to WSL paths with `wslpath` and prefix them with the configured target as an SSH URI. The general resources include both local and configured SSH targets and report each target's error separately. For a Windows Editor accessed through WSL, the extension can find the default Windows CLI even when PowerShell is absent from PATH; `PI_UNITY_REMOTE_CLI` overrides discovery. It uses `wslpath` to convert Windows Editor paths. The SSH transport disables agent and port forwarding, and does not accept an arbitrary host in a project URI. A lost connection during a mutation leaves its effect unknown; inspect the Editor before retrying.

## IDE and standalone resources

When Pi Agent IDE is loaded, its shared Read and Search can use Unity resources. Standalone `unity_read` and `unity_search` are also available without enabling the IDE extension. Catalog search matches all query words against tool names and descriptions, case-insensitively. Other URI searches match literal text in a single resource; they do not search linked resources or files. Search over an issued Read selection is handled by the resource host. No shared resource write access is registered.

## Development

From the repository root, run `pnpm --filter pi-agent-unity test:node` and `pnpm --filter pi-agent-unity typecheck`. The live two-project cases in the real-Pi integration test need two open Editors with distinct scene hierarchies:

```sh
PI_UNITY_CLI=/path/to/unity \
PI_UNITY_TEST_PROJECT_A='/absolute/project/a' \
PI_UNITY_TEST_PROJECT_B='/absolute/project/b' npx pi-test run -- vitest run --config vitest.integration.config.mjs integrations/unity/tests/live.integration.test.ts
```

The live test performs only discovery and scene hierarchy reads. It skips if the three variables are not set.

To test a remote Editor through a real Pi process, set the SSH alias, remote Linux project path, and remote CLI executable:

```sh
PI_UNITY_TEST_SSH_HOST=my-host \
PI_UNITY_TEST_SSH_PROJECT='/absolute/remote/project' \
PI_UNITY_REMOTE_CLI='/path/to/remote/unity' npx pi-test run -- vitest run --config vitest.integration.config.mjs integrations/unity/tests/live.integration.test.ts
```

The SSH test reads the tool catalog and scene hierarchy and checks that an unknown project is rejected. It requires the SSH host and project variables; `PI_UNITY_REMOTE_CLI` is optional when the remote CLI is discoverable.
