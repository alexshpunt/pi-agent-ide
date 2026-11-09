# SSH backend work in progress

This directory is the transport foundation for LPT-149. Its explicit registration bridge connects configured SSH targets to the existing read and text mutation tools. The built-in read.ssh module loads a separate ssh.json beside each global/project extensions.json. Other IDE capabilities are still unfinished; this does not satisfy the full task matrix.

`identity.ts` keeps target IDs separate from Linux paths and escapes filename characters in `ssh://` references. Paths resolve against a remote workspace without using the local platform's path rules. Only configured target aliases will be allowed by the provider registry.

`ssh.ts` runs short framed operations with system OpenSSH and transient Python code. Authentication stays in SSH config, known_hosts and the user's agent. Requests travel on stdin, not inside interpolated shell commands. Raw SSH diagnostics never become public errors. A nonzero application exit remains an application result.

File snapshots include bytes, resolved path, inode and metadata. Writes check the snapshot immediately before replacement. Directory locks serialize these backend writes. This does not eliminate an external writer racing after the check. Reads reject non-regular files; range reads and directory listing are separate operations. Text replacement follows a symlink's target, while whole-file removal rejects symlinks.

Text snapshots and short-command capture have a 32 MiB bound; chunked file transfers remain unfinished. Original-byte reads use bounded 4 MiB ranges and can cross the snapshot bound without content conversion. Byte ranges do not promise one immutable snapshot across calls; inode or metadata changes within a range or between chunks fail rather than returning a mixture of observed revisions. Atomic replacement preserves extended attributes. Hard-linked files are updated in place under an inode lock so all linked names keep their identity; these writes are not atomic, and interruption may leave a partial unknown effect. ACL-specific and interruption checks still need broader coverage.

`ssh-channel.ts` provides transient framed service stdio with ordered remote-acknowledged input, output backpressure, separate binary streams and owned-process cleanup. Its stream size is not the snapshot bound. Startup has a deadline; service lifetime lasts until exit, stop or cancellation. Queued input is bounded to 1 MiB, so callers must await writes and split larger payloads. Remote program exit 255 is distinct from SSH transport failure. PTY channels support controlling-terminal setup, dimensions, resize and foreground control keys. A PTY cannot half-close stdin independently of its shared terminal master; end() rejects without changing the process. The terminal provider uses these PTY channels when `bash` receives a remote `cwd`. Sessions share the existing output logs, screens, input and cleanup paths. Remote PID metadata stays separate from local process ownership. A foreground wait cancellation leaves the session running in the background. LSP and DAP integration, transport-loss recovery and live terminal UI verification remain unfinished.

## Checks

```sh
pnpm exec vitest run src/backend/identity.test.ts
pnpm exec vitest run --config vitest.integration.config.mjs tests/integration/ssh-backend.integration.test.ts
```

The integration fixture starts an isolated loopback sshd with disposable keys and host configuration. It does not edit user SSH files or connect a user's server. On a root Linux runner it uses the existing `agent` account; otherwise it uses the current unprivileged account. It needs system sshd, ssh-keygen, Python 3 and a usable PAM account. Missing fixture dependencies fail setup rather than silently skip SSH verification. Fixture files live in a disposable `.tmp` directory under the system temporary directory so the unprivileged account can reach them.
