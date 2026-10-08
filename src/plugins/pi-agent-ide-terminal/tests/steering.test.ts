import path from "node:path";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

import { observeQueuedSteering } from "#src/plugins/pi-agent-ide-terminal/src/steering.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

test("observes steering only after every input handler and the real queue insertion", async () => {
  const order: string[] = [];
  const session = await createSession((pi) => {
    pi.on("input", async (event) => {
      order.push("first");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { action: "transform", text: `${event.text} transformed` };
    });
    pi.on("input", () => {
      order.push("last");
    });
  });
  cleanups.push(
    observeQueuedSteering((queuedSession) => {
      expect(queuedSession).toBe(session);
      expect(session.getSteeringMessages()).toEqual(["hello transformed"]);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      order.push("queued");
    }),
  );

  await session.prompt("hello", {
    streamingBehavior: "steer",
    preflightResult: (result) => {
      expect(result).toBe("queued");
      order.push("preflight");
    },
  });

  expect(order).toEqual(["first", "last", "preflight", "queued"]);
});

test("does not release waits for follow-up, handled input, or rejected input", async () => {
  const session = await createSession((pi) => {
    pi.on("input", (event) => (event.text === "handled" ? { action: "handled" } : undefined));
  });
  const queued = vi.fn();
  cleanups.push(observeQueuedSteering(queued));

  await session.prompt("later", { streamingBehavior: "followUp" });
  await session.followUp("later too");
  expect(await session.steer("accepted")).toBe("queued");
  expect(queued).toHaveBeenCalledTimes(1);
  await session.prompt("handled", { streamingBehavior: "steer" });
  expect(await session.steer("handled")).toBe("handled");
  await expect(session.prompt("missing streaming behavior")).rejects.toThrow("already processing");
  expect(queued).toHaveBeenCalledTimes(1);
  expect(session.getSteeringMessages()).toEqual(["accepted"]);
  expect(session.getFollowUpMessages()).toEqual(["later", "later too"]);
});

test("shares one wrapper and restores the original methods when the last observer is removed", async () => {
  const session = await createSession();
  const originalPrompt = AgentSession.prototype.prompt;
  const originalSteer = AgentSession.prototype.steer;
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = observeQueuedSteering(first);
  const wrappedPrompt = AgentSession.prototype.prompt;
  const removeSecond = observeQueuedSteering(second);
  cleanups.push(removeFirst, removeSecond);
  expect(AgentSession.prototype.prompt).toBe(wrappedPrompt);

  removeFirst();
  expect(await session.steer("hello")).toBe("queued");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith(session);
  removeSecond();
  removeSecond();
  expect(AgentSession.prototype.prompt).toBe(originalPrompt);
  expect(AgentSession.prototype.steer).toBe(originalSteer);
});

async function createSession(factory?: (pi: ExtensionAPI) => void): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: path.join(process.cwd(), ".tmp/steering-sdk"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: factory === undefined ? [] : [factory],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    resourceLoader,
    agentDir: path.join(process.cwd(), ".tmp/steering-sdk"),
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    tools: [],
  });
  await session.bindExtensions({});
  vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
  cleanups.push(() => session.dispose());
  return session;
}
