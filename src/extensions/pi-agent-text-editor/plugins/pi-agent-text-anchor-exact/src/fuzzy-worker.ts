/** JavaScript run in an isolated Node Worker for bounded fuzzy search. */
export const FUZZY_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
let fuzzy;
let prepared;

function normalizeLine(value) {
  return value.replace(/[\t ]+$/u, "");
}

function normalizeLines(value) {
  const lines = value.replace(/\r\n|\r/gu, "\n").split("\n").map(normalizeLine);
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => /^\s*/u.exec(line)[0].length);
  const commonIndent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(commonIndent, line.length)));
}

const fuzzyOptions = {
  ignoreCase: true,
  ignoreSymbols: false,
  normalizeWhitespace: false,
  useDamerau: true,
  useSellers: true,
  useSeparatedUnicode: false,
};

async function prepare() {
  ({ fuzzy } = await import(workerData.moduleUrl));
  const queryLines = normalizeLines(workerData.value);
  const seeds = queryLines
    .map((text, index) => ({ text, index, weight: text.replace(/\s/gu, "").length }))
    .filter(({ weight }) => weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .slice(0, workerData.config.seedLimit);
  prepared = { queryLines, seeds };
  parentPort.postMessage({ kind: "ready" });
}

function search() {
  const { queryLines, seeds } = prepared;
  const sourceLines = workerData.sourceLines;
  const config = workerData.config;
  const starts = new Set();
  for (const seed of seeds) {
    const scoredLines = sourceLines
      .map((line, index) => ({ index, score: fuzzy(seed.text, normalizeLine(line), fuzzyOptions) }))
      .filter(({ score }) => score >= config.threshold)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, config.fuzzyCandidateLimit * 4);
    for (const line of scoredLines) {
      starts.add(Math.max(0, line.index - seed.index));
    }
  }

  const query = queryLines.join("\n");
  const searchBlocks = (varianceLimit, options) => {
    const ranked = [];
    for (const start of starts) {
      for (let variance = -varianceLimit; variance <= varianceLimit; variance += 1) {
        const length = queryLines.length + variance;
        if (length < 1 || start + length > sourceLines.length) continue;
        const end = start + length;
        const block = normalizeLines(sourceLines.slice(start, end).join("\n")).join("\n");
        const score = fuzzy(query, block, options);
        if (score >= config.threshold) ranked.push({ startLine: start + 1, endLine: end, score });
      }
    }
    return ranked;
  };

  let ranked = searchBlocks(config.blockLineVariance, fuzzyOptions);
  if (ranked.length === 0) {
    const fallbackVariance = Math.max(
      config.blockLineVariance,
      Math.min(10, Math.ceil(queryLines.length * 0.75)),
    );
    ranked = searchBlocks(fallbackVariance, { ...fuzzyOptions, normalizeWhitespace: true });
  }

  const bestByRange = new Map();
  for (const block of ranked) {
    const key = block.startLine + ":" + block.endLine;
    const current = bestByRange.get(key);
    if (current === undefined || block.score > current.score) bestByRange.set(key, block);
  }
  const blocks = [...bestByRange.values()]
    .sort((left, right) => right.score - left.score || left.startLine - right.startLine)
    .slice(0, config.fuzzyCandidateLimit);
  parentPort.postMessage({ kind: "result", blocks });
}

parentPort.once("message", (message) => {
  if (message === "search") search();
});
prepare().catch((error) => {
  parentPort.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
});
`;
