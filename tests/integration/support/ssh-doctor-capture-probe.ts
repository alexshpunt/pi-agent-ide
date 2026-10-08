import { createServer, type Socket } from "node:net";
import { DoctorCore } from "#src/doctor/core.js";
import { runDoctor } from "#src/doctor/run.js";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { visionDoctorPlugin } from "#src/plugins/pi-agent-ide-vision/src/doctor-plugin.js";
import { startSshFixture } from "./ssh-fixture.js";
import { startSshVisionFixture } from "./ssh-vision-fixture.js";

/** Run only native graphics readiness in a private desktop or headless project, then await teardown. */
export async function probeOwnedDoctorCapture(
  mode: "ready" | "missing-identity" | "headless" | "unreachable",
) {
  const graphics = mode === "ready" || mode === "missing-identity";
  const display = mode === "unreachable" ? await startSilentDisplay() : undefined;
  const fixture = await (
    graphics
      ? startSshVisionFixture({ xResource: mode === "ready" })
      : startSshFixture({}, { DISPLAY: display?.source ?? "" })
  ).catch(async (error: unknown) => {
    await display?.stop();
    throw error;
  });
  try {
    const target =
      "target" in fixture
        ? fixture.target
        : {
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          };
    const project = `ssh://fixture${target.workspace}`;
    const workspace = await createSshDoctorWorkspace(new SshBackendRegistry([target]), project);
    const core = new DoctorCore();
    await core.registerPlugin(visionDoctorPlugin);
    const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
    const findings = result.sections.find((section) => section.pluginId === "vision")?.findings;
    if (!findings) throw new Error("Missing native capture readiness report");
    if (graphics) {
      if (
        findings.length !== 2 ||
        findings[0]?.status !== "pass" ||
        findings[1]?.status !== (mode === "ready" ? "pass" : "warn")
      )
        throw new Error("Native graphics readiness reported the wrong capability");
    } else if (
      findings.length !== 1 ||
      findings[0]?.status !== "warn" ||
      findings[0].detail !==
        `${mode === "unreachable" ? "TIMEOUT" : "DESKTOP_UNAVAILABLE"}: ${project}`
    ) {
      throw new Error(`Native desktop refusal was not reported: ${JSON.stringify(findings)}`);
    }
    return { root: fixture.root, project, mode, findings };
  } finally {
    try {
      await fixture.stop();
    } finally {
      await display?.stop();
    }
  }
}

/** Accept the native X handshake but never reply, so the probe must use its deadline. */
async function startSilentDisplay() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.port < 6000) {
    server.close();
    throw new Error("No private X TCP endpoint");
  }
  return {
    source: `127.0.0.1:${address.port - 6000}`,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
