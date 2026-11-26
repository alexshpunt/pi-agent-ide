import http from "node:http";
import type { AddressInfo } from "node:net";

/** A fake Unity installer download site: only the download is simulated, the extension's installer logic is real. */
export async function installerServer(
  files: Record<string, string>,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const name = (request.url || "").replace(/^\//, "");
    if (!(name in files)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end(files[name]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** install.sh stand-in: creates the layout the official script creates under UNITY_CLI_HOME. */
export const fakeInstallSh = [
  "#!/bin/sh",
  'mkdir -p "$UNITY_CLI_HOME/bin"',
  `cat > "$UNITY_CLI_HOME/bin/unity" <<'SCRIPT'`,
  "#!/bin/sh",
  `if [ "$1" = --version ]; then echo 1.2.3; else echo '{"success":true,"data":{"instances":[]}}'; fi`,
  "SCRIPT",
  'chmod +x "$UNITY_CLI_HOME/bin/unity"',
  "",
].join("\n");
