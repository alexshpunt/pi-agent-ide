import { performance } from "node:perf_hooks";
import { createDiffModel } from "#pi-agent-text-editor-renderer/src/diff-model.js";

// Run with: pnpm exec oxnode scripts/dev/profile-tui-diff.ts
// Warm timings include line alignment, inline ranges, and viewport projection.
const cases = [
  { name: "one character", before: "timeout: 1_000", after: "timeout: 5_000" },
  { name: "pure deletion", before: "return await run();", after: "return run();" },
  {
    name: "duplicate line and insertion",
    before: "start\ncall(1);\ncall(1);\nend",
    after: "start\ncall(2);\ntrace();\ncall(1);\nend",
  },
  ...[100, 1_000, 11_000].map((size) => ({
    name: `${size} corresponding changed lines`,
    before: Array.from({ length: size }, (_, i) => `const value${i} = loadOld(${i});`).join("\n"),
    after: Array.from({ length: size }, (_, i) => `const value${i} = loadNew(${i});`).join("\n"),
  })),
];

for (const sample of cases) {
  for (let i = 0; i < 3; i++) createDiffModel(sample.before, sample.after);
  const times: number[] = [];
  let model = createDiffModel(sample.before, sample.after);
  let unavailableRuns = 0;
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    model = createDiffModel(sample.before, sample.after);
    times.push(performance.now() - start);
    if (model.omittedChanges?.unavailable) unavailableRuns++;
  }
  times.sort((left, right) => left - right);
  console.log(
    JSON.stringify({
      name: sample.name,
      p50Ms: Number(times[9]?.toFixed(2)),
      p95Ms: Number(times[18]?.toFixed(2)),
      unavailableRuns,
      added: model.added,
      modified: model.modified,
      removed: model.removed,
    }),
  );
}
