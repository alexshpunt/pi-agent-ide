import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { startTargetFixture } from "#integration/support/ssh-target-fixture.ts";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.ts";
import { remoteLocation } from "#src/backend/identity.ts";
import { SshBackendRegistry } from "#src/backend/registry.ts";
import { startSshProcess } from "#src/backend/ssh-channel.ts";
import { remotePython } from "#src/backend/ssh-transport.ts";
import { SshBackend } from "#src/backend/ssh.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

const browserRoot = process.env.PI_SSH_WINDOWS_HELPERS_ROOT;
const server = remotePython(`from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Pages(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if self.path == '/static':
            page = '<html><body><p>Static Windows page 73</p></body></html>'
        else:
            page = '<html><body><script>document.body.innerHTML="<p>Rendered Windows page 89</p>";</script></body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(page.encode('utf8'))
http = ThreadingHTTPServer(('127.0.0.1', 0), Pages)
print(http.server_port, flush=True)
http.serve_forever()`);

test.skipIf(browserRoot === undefined)(
  "Windows owner fetches and renders pages and Doctor checks the target project's setup",
  async ({ onTestFinished }) => {
    if (!browserRoot)
      throw new Error("Set PI_SSH_WINDOWS_HELPERS_ROOT to the native target browser workspace");
    const fixture = await startTargetFixture("windows");
    onTestFinished(() => fixture.stop());
    const projectRoot = remoteLocation("browser", browserRoot, "windows").path;
    const browser = { ...fixture.target, id: "browser", workspace: projectRoot };
    const backend = new SshBackend(browser);
    const directory = `${projectRoot}/doctor-${randomUUID()}`;
    await backend.ensureObjectDirectory(directory, 0o700, null);
    onTestFinished(async () => {
      const current = await backend.lstat(directory);
      await backend.removeObject(directory, current.revision);
    });
    const project = remoteLocation(browser.id, directory, "windows").source;
    const dockerFile = `${directory}/containers/dockerfile`;
    await backend.ensureObjectDirectory(`${directory}/containers`, 0o700, null);
    const original = "FROM scratch\r\n";
    await backend.write(dockerFile, Buffer.from(original), null);
    const workspace = await createSshDoctorWorkspace(new SshBackendRegistry([browser]), project);
    expect(workspace.platform).toBe("win32");
    expect(await workspace.files()).toEqual([`${project}/containers/dockerfile`]);
    const marker = `${directory}/containers/.tmp`;
    await workspace.withProbeCopy(`${project}/containers/dockerfile`, async (source) => {
      expect(source).not.toBe(`${project}/containers/dockerfile`);
      expect(await workspace.readText(source)).toBe(original);
    });
    await expect(backend.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await backend.read(dockerFile)).bytes.toString("utf8")).toBe(original);
    await backend.write(
      `${directory}/main.go`,
      Buffer.from("package main\nfunc main() {}\n"),
      null,
    );

    const channel = await startSshProcess(fixture.target, server, [], fixture.workspace);
    onTestFinished(async () => {
      await channel.stop();
    });
    channel.stderr.resume();
    const [portBytes] = (await once(channel.stdout, "data")) as [Buffer];
    const port = Number(portBytes.toString("ascii").trim());
    expect(port).toBeGreaterThan(0);
    const url = (target: string, route: string) =>
      `web:ssh://${target}/http://127.0.0.1:${port}/${route}`;

    await mkdir(path.resolve(".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/ssh-windows-web-doctor-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const config = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, "ssh.json"),
      JSON.stringify({ targets: [browser, fixture.target] }),
    );
    await writeFile(
      path.join(config, "extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: ["ide.formatter", "ide.lint", "ide.lsp"],
      }),
    );
    const options = {
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read"],
      timeoutMs: 60_000,
    };
    const web = await new PiIntegrationTest({
      ...options,
      testName: "ssh-windows-web",
      conversation: [
        assistantMessage([
          toolCall({
            id: "static",
            name: "read",
            arguments: { path: url(fixture.target.id, "static") },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "rendered",
            name: "read",
            arguments: { path: url(browser.id, "browser") },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "no-playwright",
            name: "read",
            arguments: { path: url(fixture.target.id, "browser") },
          }),
        ]),
        assistantMessage([text("Read the Windows pages")]),
      ],
    }).run("Read all three target resources");
    expect(web.exitCode).toBe(0);
    expect(getToolResultText(web, "static")).toContain("Static Windows page 73");
    expect(getToolResultText(web, "rendered")).toContain("Rendered Windows page 89");
    expect(getToolExecution(web, "no-playwright").isError).toBe(true);
    expect(getToolResultText(web, "no-playwright")).toContain("PLAYWRIGHT_UNAVAILABLE");

    const doctor = await new PiIntegrationTest({
      ...options,
      testName: "ssh-windows-doctor",
      conversation: [assistantMessage([text("Reviewed the native Windows project")])],
    }).run(`/agent-ide-doctor ${project} --no-apply --agent`);
    expect(doctor.exitCode).toBe(0);
    const report = JSON.stringify(doctor.messages);
    expect(report).toContain(project);
    expect(report).toContain("dockerfile");
    expect(report).not.toContain("PLAYWRIGHT_UNAVAILABLE");
    expect(report).not.toContain("BROWSER_FAILED");
    expect(doctor.tuiRenderedOutput).toContain(project);
    expect(doctor.tuiRenderedOutput).toMatch(/SKIP\s+Delve\b/u);
    await expect(workspace.probeBrowser?.()).resolves.toMatchObject({ ok: true });
  },
  150_000,
);
