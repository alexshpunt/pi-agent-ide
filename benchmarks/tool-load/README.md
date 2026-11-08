# Tool load benchmark

This runs many real Pi processes at once and checks that the IDE tools stay correct and fast and that memory stays bounded. Each Pi runs in TUI mode through [pi-coding-agent-test](https://www.npmjs.com/package/pi-coding-agent-test) with a scripted provider, so the measurement includes rendering and no model is called.

It is not part of `pnpm check`, the npm package or ordinary test runs. Run it by hand on a quiet machine when a change can affect performance, memory, language servers or concurrent editing.

## Run

```bash
pnpm bench:tool-load                                   # 10 agents, C++, TypeScript, Python, Rust
pnpm bench:tool-load --agents 2 --languages cpp        # quick check
pnpm bench:tool-load --agents 10 --languages cpp --shared-file 1100   # 10 agents on one file
pnpm bench:tool-load --help
```

The command exits with 0 when every check passes and 1 otherwise. It prints progress every 15 seconds and writes `report.json` and `report.md` to `.tmp/tool-load/<timestamp>/`, next to each agent's Pi trace, TUI output and probe samples.

Requirements: the Pi selected by `--pi` (default `pi`), ast-grep, and the language servers of the selected languages: `clangd`, `typescript-language-server`, `basedpyright` and `rust-analyzer` with `cargo clippy`. The run fails early when a selected language server does not start; a missing ast-grep fails its steps.

Each agent needs about 0.7 GB for Pi and 0.4 GB for the harness's terminal emulation; the four language servers together need about 5 GB. Ten agents fit in 16 GB. The runner stops every agent when free memory falls below `--stop-free-mb` (default 1024), so the kernel's OOM killer never picks unrelated processes.

## What an agent does

Agents are spread round-robin over the selected languages. Each language gets one generated project, and each agent edits its own generated file in it, of the sizes in `--sizes` (default 200, 500 and 1100 KB). With `--shared-file <kb>`, all agents of a language edit one file of that size, each in its own part, as several agents working on one large source file.

Every agent repeats the same step sequence for `--cycles` cycles: read with views, search, replace, insert, delete, copy and move of text, `ast_search`, `lsp_search`, `symbol:` targets, diagnostics reads and a Codemode batch. Each step's result is checked, and the file is checked at the end of each cycle and of the run. A diagnostics read that still finds a checker pending is recorded as a note on the first cycle, when servers start cold, and on a shared file, which can change faster than its server checks it.

`--pause-ms` sets the scripted model's think time before each step. The default 1000 ms is faster than most real model turns, which take several seconds.

## Report

- Tool latency p50, p95 and max per tool and language, and error counts.
- Per Pi process: RSS peak, heap after a full GC at the end of each cycle and its growth per cycle, event-loop delay, TUI frame count and gaps, Pi CPU and the harness's own CPU, so the harness's cost is not blamed on Pi.
- Per language: language-server process count, RSS peak and CPU.
- Machine CPU and free memory.

## Thresholds

The run fails when a session hangs (no finished tool call for `--step-timeout` seconds) or crashes, a step or final file check fails, a language-server process is left after the idle timeout, or a value exceeds `thresholds.json`:

| Key | Meaning |
| --- | --- |
| `toolLatencyMs` | p95 and max per tool; `default` applies to tools without their own entry |
| `piHeapGrowthPerCycleMb` | heap growth per cycle of one Pi process |
| `piRssPeakMb` | RSS peak of one Pi process |
| `piLoopDelayMaxMs` | longest event-loop block of one Pi process |
| `lspRssPeakMbPerLanguage` | RSS peak of one language's servers |
| `minMemAvailableMb` | lowest free memory of the machine |

The values come from the default run on ZinPC (16 threads, WSL with 15.6 GB), with about 50% headroom. Tighten them when a fix lowers the baseline. A slower machine may need its own file through `--thresholds`.

`--profile` writes V8 CPU profiles of every Pi process and of the harness to each agent's directory.
