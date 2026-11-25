import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { linearPackageRoot } from "#linear-tests/fixtures/package-root.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import { runAxi } from "#linear/axi.ts";
import { createLinearOperationBackend } from "#linear/operation-backend.ts";
import { createLinearDomainResolver } from "#linear/domain-read.ts";
import { connectLinearReadErrorGuidance } from "#linear/read-error-guidance.ts";

/** Run real AXI code across the production CLI boundary with a controlled, offline MCP client. */
export async function registerReadErrorProof(pi: ExtensionAPI, axiSource: string, guidance = true): Promise<void> {
  if (guidance) connectLinearReadErrorGuidance(pi);
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: "linear-read-error-proof",
    setup(api) {
      api.addResolver({
        priority: -500,
        resolver: {
          id: "linear-read-error-proof",
          async tryResolve(source, context) {
            const match = /^linear:\/\/example\/issue\/(ENG-85[1-9]|ENG-860)$/u.exec(source);
            if (!match) return { kind: "not-handled" };
            const identifier = match[1];
            const cwd = path.join(context.cwd, ".tmp/linear-read-proof", identifier);
            await mkdir(path.join(cwd, ".pi"), { recursive: true });
            await writeFile(path.join(cwd, ".pi/linear.json"), JSON.stringify({ axiPath: path.join(import.meta.dirname, "read-error-cli.mjs") }));
            await writeFile(path.join(cwd, "axi-proof.json"), JSON.stringify({
              axiSource, identifier, logFile: path.join(context.cwd, "axi-read-errors.jsonl"),
            }));
            const backend = createLinearOperationBackend((_cwd, args, signal) => runAxi(cwd, args, signal));
            return createLinearDomainResolver(backend).tryResolve(source, context);
          },
        },
      });
    },
  });
}

export default function readErrorProof(pi: ExtensionAPI): Promise<void> {
  return registerReadErrorProof(pi, process.env.LINEAR_TEST_AXI_SOURCE ?? path.join(linearPackageRoot, "packages", "linear-axi"));
}
