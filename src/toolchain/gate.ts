import { readFile } from "node:fs/promises";
import path from "node:path"; /**/

import type {
  ActiveToolchain,
  CompileResult,
  Diagnostic,
  FileGateResult,
  FormatResult,
  GatePhaseCallback,
  GatePhaseEntry,
  GateResult,
  LintResult,
} from "./types.js";

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function matches(tool: { extensions: readonly string[] }, extension: string): boolean {
  return tool.extensions.includes(extension) || tool.extensions.includes("*");
}

const skipCompile: CompileResult = {
  ok: true,
  diagnostics: [],
  syntaxErrors: [],
  otherDiagnostics: [],
};

const skipFormat: FormatResult = { ok: true, edits: 0 };

const skipLint: LintResult = { ok: true, diagnostics: [] };

export class Gate {
  constructor(private readonly toolchain: ActiveToolchain) {}

  async runDiagnostics(filePaths: string[]): Promise<Map<string, Diagnostic[]>> {
    const result = new Map<string, Diagnostic[]>();
    const context = this.toolchain.ctx;

    for (const filePath of filePaths) {
      const extension = extensionOf(filePath);
      const compile = await this.runCompile(filePath, extension, context);

      if (compile.syntaxErrors.length > 0) {
        result.set(filePath, compile.syntaxErrors);
        continue;
      }

      if (compile.otherDiagnostics.length > 0) {
        result.set(filePath, compile.otherDiagnostics);
        continue;
      }

      const lint = await this.runLint(filePath, extension, context, false);
      result.set(filePath, lint.diagnostics);
    }

    return result;
  }

  async runAll(
    filePaths: string[],
    options?: { onPhase?: GatePhaseCallback },
  ): Promise<GateResult> {
    const context = this.toolchain.ctx;
    const onPhase = options?.onPhase;

    // ── Read pre-gate content for all files ──
    const sourceContents: Record<string, string> = {};

    for (const fp of filePaths) {
      try {
        sourceContents[fp] = await readFile(fp, "utf8");
      } catch {
        sourceContents[fp] = "";
      }
    }

    // ── Phase setup: detect tools from ALL edited extensions ──
    const extensions = new Set(filePaths.map((fp) => extensionOf(fp)));
    const compiler =
      extensions.size > 0
        ? this.toolchain.compilers.find((c) => [...extensions].some((e) => matches(c, e)))
        : undefined;
    const linter =
      extensions.size > 0
        ? this.toolchain.linters.find((l) => [...extensions].some((e) => matches(l, e)))
        : undefined;
    const formatter =
      extensions.size > 0
        ? this.toolchain.formatters.find((f) => [...extensions].some((e) => matches(f, e)))
        : undefined;

    const phaseDefs: { phase: string; toolName: string }[] = [];

    if (compiler) {
      phaseDefs.push({ phase: "compile", toolName: compiler.name });
    }

    if (linter) {
      phaseDefs.push({ phase: "lint", toolName: linter.name });
    }

    if (formatter) {
      phaseDefs.push({ phase: "format", toolName: formatter.name });
    }

    const phaseEntries: GatePhaseEntry[] = phaseDefs.map((p) => ({
      phase: p.phase,
      toolName: p.toolName,
      status: "pending" as const,
    }));
    onPhase?.([...phaseEntries]);

    function emit(): void {
      onPhase?.([...phaseEntries]);
    }

    // Restart LSP compiler to clear stale project state after syntax errors
    // (tsserver caches broken AST after a syntax error edit)
    // await compiler?.restart?.();
    // ── 1. Compile (per-file — LSP diagnostics per document) ──
    const compilePhase = phaseEntries.find((p) => p.phase === "compile");
    const compileResults = new Map<string, CompileResult>();
    const tCompileStart = performance.now();

    // Run compile for each file in the gate
    for (const fp of filePaths) {
      if (compilePhase && compilePhase.status !== "running") {
        compilePhase.status = "running";
        emit();
      }

      const result = await this.runCompile(fp, extensionOf(fp), context);
      compileResults.set(fp, result);
    }

    if (compilePhase) {
      compilePhase.status = "done";
      compilePhase.duration = Math.round(performance.now() - tCompileStart);
      emit();
    }

    // If any file has syntax errors, skip lint and format early
    const isAnySyntaxErrors = [...compileResults.values()].some((r) => r.syntaxErrors.length > 0);

    if (isAnySyntaxErrors) {
      const files: FileGateResult[] = filePaths.map((fp) => ({
        filePath: fp,
        finalContent: sourceContents[fp] ?? "",
        sourceContent: sourceContents[fp] ?? "",
        compile: compileResults.get(fp) ?? {
          ok: true,
          diagnostics: [],
          syntaxErrors: [],
          otherDiagnostics: [],
        },
        format: { ok: true, edits: 0 },
        lint: { ok: true, diagnostics: [] },
      }));

      return { stage: "compile", rollback: false, files };
    }

    // ── 2. Lint (per-file — eslint_d per file) ──
    const lintPhase = phaseEntries.find((p) => p.phase === "lint");
    const lintResults = new Map<string, LintResult>();
    const tLintStart = performance.now();

    for (const fp of filePaths) {
      if (lintPhase && lintPhase.status !== "running") {
        lintPhase.status = "running";
        emit();
      }

      const compileResult = compileResults.get(fp);
      const result =
        compileResult !== undefined &&
        (compileResult.syntaxErrors.length > 0 || compileResult.otherDiagnostics.length > 0)
          ? skipLint
          : await this.runLint(fp, extensionOf(fp), context);
      lintResults.set(fp, result);
    }

    if (lintPhase) {
      lintPhase.status = "done";
      lintPhase.duration = Math.round(performance.now() - tLintStart);
      emit();
    }

    // ── 3. Format (per-file — dprint fmt per file) ──
    const formatPhase = phaseEntries.find((p) => p.phase === "format");
    const formatResults = new Map<string, FormatResult>();
    const tFormatStart = performance.now();

    for (const fp of filePaths) {
      if (formatPhase !== undefined && formatPhase.status !== "running") {
        formatPhase.status = "running";
        emit();
      }

      const result = await this.runFormat(fp, extensionOf(fp), context);
      formatResults.set(fp, result);
    }

    if (formatPhase) {
      formatPhase.status = "done";
      formatPhase.duration = Math.round(performance.now() - tFormatStart);
      emit();
    }

    // ── 5. Read final content for ALL files ──
    const finalContents: Record<string, string> = {};

    for (const fp of filePaths) {
      try {
        finalContents[fp] = await readFile(fp, "utf8");
      } catch {
        finalContents[fp] = sourceContents[fp] ?? "";
      }
    }

    const files: FileGateResult[] = filePaths.map((fp) => ({
      filePath: fp,
      finalContent: finalContents[fp] ?? "",
      sourceContent: sourceContents[fp] ?? "",
      compile: compileResults.get(fp) ?? {
        ok: true,
        diagnostics: [],
        syntaxErrors: [],
        otherDiagnostics: [],
      },
      format: formatResults.get(fp) ?? { ok: true, edits: 0 },
      lint: lintResults.get(fp) ?? { ok: true, diagnostics: [] },
    }));

    return { stage: "done", rollback: false, files: files };
  }

  // ── compile ───────────────────────────────────────────────────

  private async runCompile(
    filePath: string,
    extension: string,
    context: ActiveToolchain["ctx"],
  ): Promise<CompileResult> {
    const compiler = this.toolchain.compilers.find((c) => matches(c, extension));

    if (compiler === undefined) {
      return { ...skipCompile };
    }

    try {
      return await compiler.compile({ filePath }, context);
    } catch (error) {
      console.error(`[pi-agent-ide] compile failed for "${compiler.name}":`, error);
      return { ...skipCompile };
    }
  }

  // ── format ─────────────────────────────────────────────────────

  private async runFormat(
    filePath: string,
    extension: string,
    context: ActiveToolchain["ctx"],
  ): Promise<FormatResult> {
    const formatter = this.toolchain.formatters.find((f) => matches(f, extension));

    if (formatter === undefined) {
      return { ...skipFormat };
    }

    try {
      return await formatter.format({ filePath }, context);
    } catch (error) {
      console.error(`[pi-agent-ide] format failed for "${formatter.name}":`, error);
      return { ok: false, edits: 0 };
    }
  }

  // ── lint ──────────────────────────────────────────────────────

  private async runLint(
    filePath: string,
    extension: string,
    context: ActiveToolchain["ctx"],
    fix = true,
  ): Promise<LintResult> {
    const linter = this.toolchain.linters.find((l) => matches(l, extension));

    if (linter === undefined) {
      return { ...skipLint };
    }

    try {
      return await linter.lint({ filePath, fix }, context);
    } catch (error) {
      console.error(`[pi-agent-ide] lint failed for "${linter.name}":`, error);
      return { ok: false, diagnostics: [] };
    }
  }
}
