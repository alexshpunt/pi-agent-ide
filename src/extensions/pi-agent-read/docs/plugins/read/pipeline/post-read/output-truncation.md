# Read output truncation

## Purpose

`pi-agent-read` limits final output that contains one text block before it reaches the agent. This protects the model context even when a resolver or pipeline handler produces a large result.

Truncation changes only the returned tool content. It does not change the resolved Resource, the source snapshot, or the source line count.

## Limits

The core uses Pi's standard limits:

- 2,000 rendered lines;
- 50 KiB of UTF-8 text;
- whichever limit is reached first.

The core keeps the beginning of the output and never returns a partial line. Native non-text content is unchanged.

## Processing

The limit applies at the final core boundary, after `post-read` handlers. It also applies to terminal textual results returned by earlier pipeline stages.

For a line-addressable result, the core:

1. measures the final rendered text;
2. keeps complete lines within both limits;
3. adds a notice with the shown source range and next `offset`;
4. stores Pi's `TruncationResult` in `ReadResultDetails.truncation`.

A typical notice is:

```text
[Showing lines 1-2000 of 8431. Use offset=2001 to continue.]
```

A byte-limited notice also names the 50 KiB limit. When an explicit `limit` stops before the end of the source, the result reports the remaining line count and next `offset` even when automatic truncation was not needed.

## Long single lines

If the first rendered line alone exceeds 50 KiB, the core returns no partial source text. It returns a notice with the line size and tells the agent to use a source-specific tool that supports smaller byte ranges.

The notice is display text. It is not canonical source content and has no source-line metadata.

## Result metadata

`ReadResultDetails.truncation` uses Pi's exported `TruncationResult` contract. It records the active limits, original size, returned size, the limit that was reached, and whether the first line exceeded the byte limit.

When line metadata is present, `ReadResultDetails.lines` keeps only the retained output lines.

A resolver may enable `preserveTruncatedOutput`. Core then saves the complete final text after all presenters and post-read handlers and adds its `temp:<id>` source to the notice and `ReadResultDetails.temporarySource`. Explicit `limit` requests do not create snapshots.

The `temp` protocol returns the saved text without running handlers or presenters again. It supports normal line ranges and the same output limit. Each read resets a five-minute inactivity period. Core deletes all temporary resources on session shutdown.

## Non-goals

Output truncation does not:

- read or resolve sources;
- change source authorization;
- shorten canonical text stored in pipeline state;
- truncate images or mixed native content;
- guarantee that a source-specific byte-range reader is installed.
