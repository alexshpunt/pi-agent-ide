/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NamedConnections } from "../src/named-connections.ts";

void test("cancellation during login setup cleans up the reservation", async () => {
  const program = `
    import { managedAuthCommand } from './src/commands/managed-auth.ts';
    const connection = {
      async beginLogin() {
        console.log('starting');
        await new Promise(resolve => setTimeout(resolve, 200));
        return { epoch: 'fixture', url: 'https://linear.app/oauth/authorize?state=fixture', redirectUri: 'http://127.0.0.1:14566/oauth/callback' };
      },
      async cancelLogin(epoch) { if (epoch === 'fixture') console.log('cleaned'); },
    };
    try { await managedAuthCommand(['login'], { env: {}, connection }); process.exitCode = 1; }
    catch (error) { if (error.message !== 'LINEAR_AUTH_CANCELLED') process.exitCode = 1; }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let output = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("login setup did not start")), 5000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("starting")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("login exited before setup"));
      });
    });
    const exited = once(child, "close");
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
    assert.match(output, /cleaned/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

void test("cancelling interactive login releases the reserved name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-login-cancel-"));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: directory,
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "fixture-client-id",
    LINEAR_AXI_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/callback`,
  };
  const child = spawn(
    process.execPath,
    [
      "src/bin.ts",
      "auth",
      "login",
      "--actor",
      "app",
      "--method",
      "oauth",
      "--name",
      "Fixture",
      "--json",
    ],
    {
      cwd: join(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    let output = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("login did not start")), 5000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes('"event":"authorization"')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("login exited before authorization"));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    const manager = new NamedConnections({ env });
    const retry = await manager.beginLogin({ actor: "app", method: "oauth", name: "Fixture" });
    assert.ok(retry.epoch);
    await manager.cancelLogin(retry.epoch);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
