import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend, type SshTarget } from "#src/backend/ssh.js";

/** Route only one private fixture's encrypted SSH traffic; cut owned sockets, never host networking. */
export async function startSshCarrierFixture(
  tools: Readonly<Record<string, string>> = {},
  environment: Readonly<Record<string, string>> = {},
) {
  const fixture = await startSshFixture(tools, environment);
  let proxy: net.Server | undefined;
  const connections = new Set<{
    client: net.Socket;
    upstream: net.Socket;
    closed: Promise<void>;
  }>();
  const dropConnections = async () => {
    const active = [...connections];
    for (const connection of active) {
      connection.client.destroy();
      connection.upstream.destroy();
    }
    await Promise.all(active.map((connection) => connection.closed));
    return active.length;
  };
  try {
    // This is the generated fixture configuration, not a user SSH file or a key.
    const config = await readFile(fixture.config, "utf8");
    const portLine = /^  Port (\d+)$/mu.exec(config);
    if (!portLine) throw new Error("No private fixture SSH port");
    const upstreamPort = Number(portLine[1]);
    proxy = net.createServer((client) => {
      const upstream = net.createConnection({ host: "127.0.0.1", port: upstreamPort });
      const closed = Promise.all(
        [client, upstream].map(
          (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
        ),
      ).then(() => {});
      const connection = { client, upstream, closed };
      connections.add(connection);
      void closed.then(() => connections.delete(connection));
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("No owned proxy port");
    const proxyConfig = `${fixture.root}/carrier_ssh_config`;
    // Keep strict host-key validation against the original private server through its tunnel.
    await writeFile(
      proxyConfig,
      config.replace(
        portLine[0],
        `  Port ${address.port}\n  HostKeyAlias [127.0.0.1]:${upstreamPort}`,
      ),
    );
    const target: SshTarget = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: proxyConfig,
    };
    const direct = new SshBackend({ ...target, configFile: fixture.config });
    const ownedProxy = proxy;
    return {
      root: fixture.root,
      workspace: fixture.workspace,
      target,
      direct,
      dropConnections,
      async stop() {
        await dropConnections();
        await new Promise<void>((resolve, reject) =>
          ownedProxy.close((error) => (error ? reject(error) : resolve())),
        );
        await fixture.stop();
      },
    };
  } catch (error) {
    await dropConnections();
    if (proxy?.listening) {
      const ownedProxy = proxy;
      await new Promise<void>((resolve, reject) =>
        ownedProxy.close((failure) => (failure ? reject(failure) : resolve())),
      );
    }
    await fixture.stop();
    throw error;
  }
}
