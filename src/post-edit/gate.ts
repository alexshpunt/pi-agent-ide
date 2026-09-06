import path from "node:path";

import { warmupFormatting } from "#src/toolchain/registry.js";
import type { TextPostEditTransaction } from "pi-agent-text-editor/api/post-edit";

/** Finish only file-writing work. Diagnostics are scheduled after final edit completion. */
export async function runIdePostEditGate(transaction: TextPostEditTransaction): Promise<undefined> {
  if (!path.isAbsolute(transaction.resourceSource)) return;
  const toolchain = await warmupFormatting({ cwd: transaction.cwd });
  const extension = path.extname(transaction.resourceSource).toLowerCase();
  const matches = (tool: { extensions: readonly string[] }) =>
    tool.extensions.includes(extension) || tool.extensions.includes("*");
  const syntax = toolchain.compilers.find(matches);
  if (syntax) {
    const result = await syntax.compile({ filePath: transaction.resourceSource }, toolchain.ctx);
    if (result.syntaxErrors.length > 0) return;
  }
  // Configured formatters may use their own parser to reject invalid syntax safely.
  const formatter = toolchain.formatters.find(matches);
  await formatter?.format({ filePath: transaction.resourceSource }, toolchain.ctx);
}
