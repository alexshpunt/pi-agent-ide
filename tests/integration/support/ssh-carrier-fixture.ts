import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { SshBackend, type SshTarget } from "#src/backend/ssh.ts";

/** Route only one private fixture's encrypted SSH traffic; cut owned sockets, never host networking. */
export async function startSshCarrierFixture(
  tools: Readonly<Record<string, string>> = {},
  environment: Readonly<Record<string, string>> = {},
) {
  const fixture = await startSshFixture(tools, environment);
  let proxy: net.Server | undefined;
  let accepted = 0;
  let closeBeforeHandshake = 0;
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
      accepted++;
      if (closeBeforeHandshake > 0) {
        closeBeforeHandshake--;
        client.destroy();
        return;
      }
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
      /** Close the next count connections as soon as they arrive, before any SSH byte. */
      closeNextConnections(count: number) {
        closeBeforeHandshake = count;
      },
      /** Connections the proxy has accepted so far, including closed ones. */
      get acceptedConnections() {
        return accepted;
      },
      /** Stop listening, so new connections to the target's port are refused. */
      async refuseConnections() {
        await dropConnections();
        await closeProxy(ownedProxy);
        // Right after close() a connection can still be accepted and then reset.
        while (!(await portRefuses(address.port))) await delay(10);
      },
      async stop() {
        await dropConnections();
        await closeProxy(ownedProxy);
        await fixture.stop();
      },
    };
  } catch (error) {
    await dropConnections();
    if (proxy) await closeProxy(proxy);
    await fixture.stop();
    throw error;
  }
}

function portRefuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
  });
}

async function closeProxy(proxy: net.Server): Promise<void> {
  if (!proxy.listening) return;
  await new Promise<void>((resolve, reject) =>
    proxy.close((error) => (error ? reject(error) : resolve())),
  );
}
