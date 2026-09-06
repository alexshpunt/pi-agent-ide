import{a as y}from"./chunk-MTTKFJV6.js";import{a as s}from"./chunk-EI7MMDWY.js";import{Worker as v}from"node:worker_threads";var p=String.raw`
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
`;async function x(n,e,r){if(e.rejection.code==="ambiguous"){let i=b(n,e,r.exactCandidateLimit);return{kind:"candidates",total:i.total,candidates:i.ranges.map((a,c)=>({rank:c+1,range:a}))}}if(e.rejection.code!=="missing"||!z(n,e.content,r))return{kind:"unavailable"};if(e.signal!==void 0&&e.signal.aborted)return{kind:"failed",error:e.signal.reason};let t=await R(n,e.lines,r,e.signal);if(t.kind!=="blocks")return t.outcome;let o=[];for(let[i,a]of t.blocks.entries()){let c=e.lines[a.endLine-1];if(c===void 0)return{kind:"failed",error:new Error("Fuzzy Worker returned an invalid source range")};o.push({rank:i+1,range:{start:{lineNumber:a.startLine,column:0},end:{lineNumber:a.endLine,column:c.length}}})}return{kind:"candidates",candidates:o,total:o.length}}s(x,"recoverExactText");function z(n,e,r){if(!r.fuzzyEnabled||n.replace(/\s/gu,"").length<4)return!1;let t=new TextEncoder;return t.encode(n).byteLength<=r.maxQuerySizeKiB*1024&&t.encode(e).byteLength<=r.maxFileSizeMiB*1024*1024}s(z,"canSearch");function R(n,e,r,t){return new Promise(o=>{let i=new v(p,{eval:!0,workerData:{moduleUrl:import.meta.resolve("fast-fuzzy"),value:n,sourceLines:e,config:r}}),a=!1,c,u=s(l=>{a||(a=!0,c!==void 0&&clearTimeout(c),t!==void 0&&t.removeEventListener("abort",d),i.terminate(),o(l))},"finish"),d=s(()=>{t!==void 0&&u({kind:"outcome",outcome:{kind:"failed",error:t.reason}})},"abort");t!==void 0&&t.addEventListener("abort",d,{once:!0}),i.on("error",l=>u({kind:"outcome",outcome:{kind:"failed",error:l}})),i.on("message",l=>{if(l.kind==="ready"){c=setTimeout(()=>u({kind:"outcome",outcome:{kind:"timed-out"}}),r.timeoutMs),i.postMessage("search",[]);return}if(l.kind==="failed"){u({kind:"outcome",outcome:{kind:"failed",error:new Error(l.message??"Fuzzy Worker failed")}});return}if(l.blocks===void 0){u({kind:"outcome",outcome:{kind:"failed",error:new Error("Fuzzy Worker omitted result blocks")}});return}u({kind:"blocks",blocks:l.blocks})})})}s(R,"runFuzzyWorker");function q(n){return{id:"exact-text",description:"Any non-empty value not handled as a structured anchor selects one unique exact text span.",renderFull(e){return e},renderCompact(){return"selected text"},tryResolve(e,r){return Promise.resolve(T(e,r))},recover(e,r){return x(e,r,n)}}}s(q,"createExactTextAnchorResolver");function T(n,e){if(n.length===0)return k("invalid","exact text anchor must be non-empty");let r=m(f(e.content)),t=m(f(n)).text,o=A(r.text,t,2);if(o.length===0)return k("missing","exact text anchor was not found");if(o.length>1)return k("ambiguous","exact text anchor matched more than once");let i=o[0];if(i===void 0)return{kind:"failed",error:new Error("Exact match index is missing")};let a=e.content.startsWith("\uFEFF")?1:0,c=a+h(r.boundaries,i),u=a+h(r.boundaries,i+t.length),d=w(e.content,c,u),l=d?E(e.content,u):u,L={start:g(e.content,c),end:g(e.content,l),...d&&{linewise:!0}};return{kind:"resolved",anchor:new y(n,e.source,[L])}}s(T,"resolveExactTextAnchor");function b(n,e,r){let t=m(f(e.content)),o=m(f(n)).text;if(o.length===0)return{ranges:[],total:0};let i=C(t.text,o,r),a=e.content.startsWith("\uFEFF")?1:0;return{total:i.total,ranges:i.starts.map(c=>({start:g(e.content,a+h(t.boundaries,c)),end:g(e.content,a+h(t.boundaries,c+o.length))}))}}s(b,"findExactTextMatches");function w(n,e,r){let t=e===0||n[e-1]===`
`||n[e-1]==="\r",o=r===n.length||n[r]===`
`||n[r]==="\r"||n[r-1]===`
`||n[r-1]==="\r";return t&&o}s(w,"isWholeLineMatch");function E(n,e){return n[e]==="\r"&&n[e+1]===`
`?e+2:n[e]==="\r"||n[e]===`
`?e+1:e}s(E,"includeTrailingLineBreak");function k(n,e){return{kind:"rejected",rejection:{code:n,reason:e}}}s(k,"rejected");function f(n){return n.startsWith("\uFEFF")?n.slice(1):n}s(f,"stripInitialBom");function m(n){let e=[],r=[0];for(let t=0;t<n.length;t+=1){let o=n[t];if(o==="\r"){let i=n[t+1]===`
`?2:1;e.push(`
`),t+=i-1,r.push(t+1);continue}e.push(o??""),r.push(t+1)}return{text:e.join(""),boundaries:r}}s(m,"normalizeText");function A(n,e,r){if(e.length===0)return[];let t=[],o=0;for(;t.length<r&&o<=n.length-e.length;){let i=n.indexOf(e,o);if(i===-1)break;t.push(i),o=i+1}return t}s(A,"overlappingMatches");function C(n,e,r){if(e.length===0)return{starts:[],total:0};let t=[],o=0,i=0;for(;i<=n.length-e.length;){let a=n.indexOf(e,i);if(a===-1)break;o+=1,t.length<r&&t.push(a),i=a+1}return{starts:t,total:o}}s(C,"scanMatches");function h(n,e){let r=n[e];if(r===void 0)throw new RangeError("Exact text match is outside normalized source boundaries");return r}s(h,"boundaryAt");function g(n,e){let r=1,t=0;for(let o=0;o<e;o+=1){let i=n[o];i==="\r"?(n[o+1]===`
`&&(o+=1),r+=1,t=0):i===`
`?(r+=1,t=0):t+=1}return{lineNumber:r,column:t}}s(g,"positionAt");export{q as a,T as b,b as c};
