import path from "node:path";

import { warmupFormatting } from "#src/toolchain/registry.js";
import type { MutationFormatting } from "pi-agent-text-editor/api/mutation-result";
import type {
  TextPostEditTransaction,
  TextPostEditStatusContribution,
} from "pi-agent-text-editor/api/post-edit";

/** Finish file-writing work and report the formatter outcome, separately from diagnostics. */
export async function runIdePostEditGate(
  transaction: TextPostEditTransaction,
): Promise<{ formatting: MutationFormatting } & Partial<TextPostEditStatusContribution>> {
  if (!path.isAbsolute(transaction.resourceSource))
    return { formatting: { status: "unavailable" } };
  let formatterName: string | undefined;
  try {
    const toolchain = await warmupFormatting({ cwd: transaction.cwd });
    const extension = path.extname(transaction.resourceSource).toLowerCase();
    const matches = (tool: { extensions: readonly string[] }) =>
      tool.extensions.includes(extension) || tool.extensions.includes("*");
    const syntax = toolchain.compilers.find(matches);
    if (syntax) {
      const result = await syntax.compile({ filePath: transaction.resourceSource }, toolchain.ctx);
      if (result.syntaxErrors.length > 0) return { formatting: { status: "skipped-syntax" } };
    }
    const formatter = toolchain.formatters.find(matches);
    if (!formatter) return { formatting: { status: "unavailable" } };
    formatterName = formatter.name;
    const result = await formatter.format({ filePath: transaction.resourceSource }, toolchain.ctx);
    if (result.formatter === null) return { formatting: { status: "unavailable" } };
    formatterName = result.formatter ?? formatter.name;
    return {
      formatting: {
        status: !result.ok ? "failed" : result.edits > 0 ? "changed" : "unchanged",
        formatter: formatterName,
      },
      ...(result.ok
        ? { diffStatuses: [{ text: `Formatted (${formatterName})`, tone: "success" as const }] }
        : {}),
    };
  } catch {
    return {
      formatting: {
        status: "failed",
        ...(formatterName === undefined ? {} : { formatter: formatterName }),
      },
    };
  }
}
