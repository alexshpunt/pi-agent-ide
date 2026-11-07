/** Deterministic large-project generators for the load benchmark, one per language server. */

export type LanguageId = "cpp" | "typescript" | "python" | "rust";

export interface LanguageSpec {
  readonly id: LanguageId;
  /** Command that prints the version of the language server Pi Agent IDE starts for this language. */
  readonly serverVersion: readonly string[];
  /** Matches language server process command lines (comm or argv) for memory sampling. */
  readonly serverProcess: RegExp;
  readonly extension: string;
  /** ast-grep language name. */
  readonly astLanguage: string;
  readonly comment: string;
  /** Project configuration files keyed by path relative to the project root. */
  projectFiles(agents: readonly string[]): Record<string, string>;
  /** One generated unit: marker line, a function that calls the previous unit, end line. */
  unitFunction(agent: string, index: number, variant: number): string;
  /** A self-contained function nobody calls. */
  detachedFunction(agent: string, index: number): string;
  /** A valid function inserted and deleted again in one cycle. */
  extraFunction(agent: string, cycle: number): string;
  /** One line with a type error that the language server must report. */
  brokenLine(agent: string, cycle: number): string;
  /** First line of the scratch file. */
  scratchHeader(agent: string, cycle: number): string;
}

export const DETACHED_COUNT = 8;

export function unitName(agent: string, index: number): string {
  return `unit_${agent}_${pad(index)}`;
}

export function detachedName(agent: string, index: number): string {
  return `detached_${agent}_${index}`;
}

export function unitMarker(spec: LanguageSpec, agent: string, index: number): string {
  return `${spec.comment} marker ${agent} u${pad(index)}`;
}

export function unitEnd(spec: LanguageSpec, agent: string, index: number): string {
  return `${spec.comment} end ${agent} u${pad(index)}`;
}

export function detachedMarker(spec: LanguageSpec, agent: string, index: number): string {
  return `${spec.comment} marker ${agent} d${index}`;
}

export function detachedEnd(spec: LanguageSpec, agent: string, index: number): string {
  return `${spec.comment} end ${agent} d${index}`;
}

export function extraMarker(spec: LanguageSpec, agent: string, cycle: number): string {
  return `${spec.comment} marker ${agent} extra${cycle}`;
}

export function extraEnd(spec: LanguageSpec, agent: string, cycle: number): string {
  return `${spec.comment} end ${agent} extra${cycle}`;
}

/** The body line that a step edits; unique in the file because it carries the unit index. */
export function unitStepLine(index: number): string {
  return `total += step * ${unitConstant(index)}`;
}

function unitConstant(index: number): string {
  return `1${pad(index)}`;
}

function pad(index: number): string {
  return String(index).padStart(5, "0");
}

function callPrevious(agent: string, index: number): string {
  return index === 0 ? "0" : `${unitName(agent, index - 1)}(value % 3)`;
}

/**
Blank lines keep the marker comments out of the declaration: rust-analyzer's symbol range
includes comments directly above an item, other servers' ranges do not.
*/
function wrap(marker: string, body: string, end: string): string {
  return `${marker}\n\n${body}\n\n${end}\n`;
}

const cpp: LanguageSpec = {
  id: "cpp",
  serverVersion: ["clangd", "--version"],
  serverProcess: /^clangd/,
  extension: "cpp",
  astLanguage: "cpp",
  comment: "//",
  projectFiles: () => ({
    ".clangd": "CompileFlags:\n  Add: [-std=c++20, -ferror-limit=0]\n",
    "compile_flags.txt": "-std=c++20\n-ferror-limit=0\n",
  }),
  unitFunction: (agent, index, variant) =>
    wrap(
      unitMarker(cpp, agent, index),
      [
        `int ${unitName(agent, index)}(int value) {`,
        "  int total = value;",
        "  for (int step = 0; step < 4; ++step) {",
        `    ${unitStepLine(index)};`,
        "  }",
        `  return total + ${variant} + ${callPrevious(agent, index)};`,
        "}",
      ].join("\n"),
      unitEnd(cpp, agent, index),
    ),
  detachedFunction: (agent, index) =>
    wrap(
      detachedMarker(cpp, agent, index),
      `int ${detachedName(agent, index)}(int value) {\n  return value * 7 + ${index};\n}`,
      detachedEnd(cpp, agent, index),
    ),
  extraFunction: (agent, cycle) =>
    wrap(
      extraMarker(cpp, agent, cycle),
      `int extra_${agent}_${cycle}(int value) {\n  return value + ${cycle};\n}`,
      extraEnd(cpp, agent, cycle),
    ),
  brokenLine: (agent, cycle) => `int broken_${agent}_${cycle} = "not a number";`,
  scratchHeader: (agent, cycle) => `// scratch ${agent} cycle ${cycle}`,
};

const typescript: LanguageSpec = {
  id: "typescript",
  serverVersion: ["typescript-language-server", "--version"],
  serverProcess: /typescript-language-server|tsserver/,
  extension: "ts",
  astLanguage: "typescript",
  comment: "//",
  projectFiles: () => ({
    "package.json": `${JSON.stringify({ name: "tool-load-typescript", private: true, type: "module" }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  }),
  unitFunction: (agent, index, variant) =>
    wrap(
      unitMarker(typescript, agent, index),
      [
        `export function ${unitName(agent, index)}(value: number): number {`,
        "  let total = value;",
        "  for (let step = 0; step < 4; step++) {",
        `    ${unitStepLine(index)};`,
        "  }",
        `  return total + ${variant} + ${callPrevious(agent, index)};`,
        "}",
      ].join("\n"),
      unitEnd(typescript, agent, index),
    ),
  detachedFunction: (agent, index) =>
    wrap(
      detachedMarker(typescript, agent, index),
      `export function ${detachedName(agent, index)}(value: number): number {\n  return value * 7 + ${index};\n}`,
      detachedEnd(typescript, agent, index),
    ),
  extraFunction: (agent, cycle) =>
    wrap(
      extraMarker(typescript, agent, cycle),
      `export function extra_${agent}_${cycle}(value: number): number {\n  return value + ${cycle};\n}`,
      extraEnd(typescript, agent, cycle),
    ),
  brokenLine: (agent, cycle) => `export const broken_${agent}_${cycle}: number = "not a number";`,
  scratchHeader: (agent, cycle) => `// scratch ${agent} cycle ${cycle}\nexport {};`,
};

const python: LanguageSpec = {
  id: "python",
  // The built-in Python server is basedpyright-langserver; its own --version starts the server.
  serverVersion: ["basedpyright", "--version"],
  serverProcess: /pyright/,
  extension: "py",
  astLanguage: "python",
  comment: "#",
  projectFiles: () => ({
    "pyrightconfig.json": `${JSON.stringify({ include: ["src"], typeCheckingMode: "standard" }, null, 2)}\n`,
  }),
  unitFunction: (agent, index, variant) =>
    wrap(
      unitMarker(python, agent, index),
      [
        `def ${unitName(agent, index)}(value: int) -> int:`,
        "    total = value",
        "    for step in range(4):",
        `        ${unitStepLine(index)}`,
        `    return total + ${variant} + ${callPrevious(agent, index)}`,
      ].join("\n"),
      unitEnd(python, agent, index),
    ),
  detachedFunction: (agent, index) =>
    wrap(
      detachedMarker(python, agent, index),
      `def ${detachedName(agent, index)}(value: int) -> int:\n    return value * 7 + ${index}`,
      detachedEnd(python, agent, index),
    ),
  extraFunction: (agent, cycle) =>
    wrap(
      extraMarker(python, agent, cycle),
      `def extra_${agent}_${cycle}(value: int) -> int:\n    return value + ${cycle}`,
      extraEnd(python, agent, cycle),
    ),
  brokenLine: (agent, cycle) => `broken_${agent}_${cycle}: int = "not a number"`,
  scratchHeader: (agent, cycle) => `# scratch ${agent} cycle ${cycle}`,
};

const rust: LanguageSpec = {
  id: "rust",
  serverVersion: ["rust-analyzer", "--version"],
  serverProcess: /rust-analyzer/,
  extension: "rs",
  astLanguage: "rust",
  comment: "//",
  projectFiles: (agents) => ({
    "Cargo.toml":
      '[package]\nname = "tool_load_rust"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
    "src/lib.rs": `${agents
      .flatMap((agent) => [`pub mod agent_${agent};`, `pub mod scratch_${agent};`])
      .join("\n")}\n`,
  }),
  unitFunction: (agent, index, variant) =>
    wrap(
      unitMarker(rust, agent, index),
      [
        `pub fn ${unitName(agent, index)}(value: i64) -> i64 {`,
        "    let mut total = value;",
        "    for step in 0..4 {",
        `        ${unitStepLine(index)};`,
        "    }",
        `    total + ${variant} + ${callPrevious(agent, index)}`,
        "}",
      ].join("\n"),
      unitEnd(rust, agent, index),
    ),
  detachedFunction: (agent, index) =>
    wrap(
      detachedMarker(rust, agent, index),
      `pub fn ${detachedName(agent, index)}(value: i64) -> i64 {\n    value * 7 + ${index}\n}`,
      detachedEnd(rust, agent, index),
    ),
  extraFunction: (agent, cycle) =>
    wrap(
      extraMarker(rust, agent, cycle),
      `pub fn extra_${agent}_${cycle}(value: i64) -> i64 {\n    value + ${cycle}\n}`,
      extraEnd(rust, agent, cycle),
    ),
  brokenLine: (agent, cycle) =>
    `pub const BROKEN_${agent.toUpperCase()}_${cycle}: i64 = "not a number";`,
  scratchHeader: (agent, cycle) => `// scratch ${agent} cycle ${cycle}`,
};

export const languages: Readonly<Record<LanguageId, LanguageSpec>> = {
  cpp,
  typescript,
  python,
  rust,
};

export interface GeneratedSource {
  readonly content: string;
  readonly unitCount: number;
  /** One-based line number of each unit marker. */
  readonly unitLines: readonly number[];
}

/** Builds a source file of at least `targetBytes`, with detached functions spread through it. */
export function generateSource(
  spec: LanguageSpec,
  agent: string,
  targetBytes: number,
): GeneratedSource {
  const sample = spec.unitFunction(agent, 99_999, 0).length + 1;
  const unitCount = Math.max(DETACHED_COUNT * 4, Math.ceil(targetBytes / sample));
  const detachedEvery = Math.floor(unitCount / DETACHED_COUNT);
  const parts = [`${spec.comment} Generated by benchmarks/tool-load for agent ${agent}.\n\n`];
  const unitLines: number[] = [];
  let line = 3;
  for (let index = 0; index < unitCount; index += 1) {
    if (index % detachedEvery === detachedEvery - 1 && index / detachedEvery < DETACHED_COUNT) {
      const detached = `${spec.detachedFunction(agent, Math.floor(index / detachedEvery))}\n`;
      parts.push(detached);
      line += lineCount(detached);
    }
    const unit = `${spec.unitFunction(agent, index, 0)}\n`;
    unitLines.push(line);
    parts.push(unit);
    line += lineCount(unit);
  }
  return { content: parts.join(""), unitCount, unitLines };
}

function lineCount(text: string): number {
  return text.split("\n").length - 1;
}
