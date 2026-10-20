import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** An isolated package fixture: lifecycle effects must happen without invoking its transport. */
export default function preflightConnector(pi: ExtensionAPI): void {
  const config = JSON.parse(readFileSync(new URL("./fixture-config.json", import.meta.url), "utf8")) as {
    port: number;
    hostSentinel: string;
  };
  let inferenceCalls = 0;
  const marker = (name: string, exposure: "hidden" | "direct" = "hidden") =>
    pi.registerTool({
      name,
      label: name,
      description: "Preflight fixture state marker.",
      namespace: { name: "preflight_fixture", description: "Synthetic lifecycle observations." },
      parameters: { type: "object", properties: {} },
      exposure,
      async execute() {
        throw Error("A load preflight must not execute tools");
      },
    });
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    baseUrl: "https://preflight.invalid",
    models: [
      {
        id: "preflight-fixture",
        name: "Preflight fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 1024,
        maxTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple() {
      inferenceCalls++;
      throw Error("A load preflight must not invoke the provider");
    },
  });
  pi.on("session_start", async () => {
    let networkDenied = false;
    try {
      await fetch(`http://127.0.0.1:${config.port}`, { signal: AbortSignal.timeout(500) });
    } catch {
      networkDenied = true;
    }
    const auth = JSON.parse(readFileSync(`${process.env.PI_CODING_AGENT_DIR}/auth.json`, "utf8")) as {
      anthropic?: { access?: string; refresh?: string };
    };
    if (networkDenied) marker("preflight_network_blocked", "direct");
    if (existsSync(config.hostSentinel)) marker("preflight_host_leak");
    if (process.env.ANTHROPIC_API_KEY) marker("preflight_env_leak");
    if (auth.anthropic?.access?.startsWith("sk-ant-oat01-PREFLIGHT") && auth.anthropic.refresh === "")
      marker("preflight_synthetic_auth");
    if (pi.getAllTools().some((tool) => tool.name === "read" && tool.namespace?.name === "ide_read"))
      marker("preflight_ide_loaded");
  });
  pi.on("session_shutdown", () => {
    marker(inferenceCalls === 0 ? "preflight_never_inferred" : "preflight_inference_leak");
  });
}
