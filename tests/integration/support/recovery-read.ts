import type { ReadRequest } from "pi-agent-read/api/tools/read";

type RecoveryRead = Pick<ReadRequest, "offset" | "limit" | "views"> & { readonly path: string };

export function recoveryReadArguments(message: string): RecoveryRead {
  const args = /\bread\((\{[^\n]*\})\)/u.exec(message)?.[1];
  if (args === undefined) throw new Error(`No ready Read call in: ${message}`);
  return JSON.parse(args) as RecoveryRead;
}
