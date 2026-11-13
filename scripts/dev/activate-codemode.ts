import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Configure an explicitly requested native Codemode mode, or activate the existing built-in
 * as the defaultTools: ["+codemode"] setting does in the isolated exporter.
 */
export default async function activateCodemode(pi: ExtensionAPI): Promise<void> {
  const mode = process.env.PI_AGENT_INTERFACE_CODEMODE_MODE;
  if (mode !== undefined && mode !== "") {
    if (mode !== "on" && mode !== "only") throw new Error("Invalid interface Codemode mode");
    await createCodemodeExtension({ mode })(pi);
  }
  if (process.env.PI_AGENT_INTERFACE_ACTIVATE_CODEMODE === "0") return;
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
  });
}
