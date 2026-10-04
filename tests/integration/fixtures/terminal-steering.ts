import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send input through the real Pi session API while the terminal tool is waiting. */
export default function terminalSteering(pi: ExtensionAPI): void {
  let session: AgentSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const originalPrompt = AgentSession.prototype.prompt;
  const capturePrompt: AgentSession["prompt"] = function (this: AgentSession, ...args) {
    session = this;
    return originalPrompt.apply(this, args);
  };
  AgentSession.prototype.prompt = capturePrompt;

  pi.on("input", async (event) => {
    if (event.text !== "terminal-steering-input") return;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { action: "transform", text: "terminal-steering-transformed" };
  });
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "bash" || session === undefined) return;
    const activeSession = session;
    timer = setTimeout(() => {
      const method = process.env.PI_TERMINAL_STEERING_METHOD ?? "prompt";
      const input = method === "steer"
        ? activeSession.steer("terminal-steering-input")
        : activeSession.prompt("terminal-steering-input", {
            streamingBehavior: method === "followUp" ? "followUp" : "steer",
          });
      void input.catch((error: unknown) => {
        pi.appendEntry("terminal-steering-error", String(error));
      });
    }, 100);
  });
  pi.on("session_shutdown", () => {
    clearTimeout(timer);
    if (AgentSession.prototype.prompt === capturePrompt) {
      AgentSession.prototype.prompt = originalPrompt;
    }
  });
}
