import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdeDiagnosticReport } from "pi-agent-ide/api/plugin-protocol";

export default async function diagnosticsFixture(pi: ExtensionAPI): Promise<void> {
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "diagnostics-tool-fixture",
    setup(api) {
      api.addDiagnosticSource({
        id: "fixture",
        async diagnose(filePath, context) {
          const status = /\/(pending|unavailable|snapshot|ready)\.note$/u.exec(filePath)?.[1];
          if (status === "pending")
            return new Promise<IdeDiagnosticReport>((_resolve, reject) => {
              context.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
                once: true,
              });
            });
          if (status === "unavailable" || status === "snapshot" || status === "ready")
            return { status, diagnostics: [] };
          return {
            status: "ready",
            diagnostics: [
              {
                line: 1,
                column: 14,
                severity: "warning",
                code: "FIXTURE42",
                message: "Fixture finding",
              },
            ],
          };
        },
      });
    },
  });
}
