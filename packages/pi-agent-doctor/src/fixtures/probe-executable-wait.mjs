import { existsSync, writeFileSync } from "node:fs";

const [marker, release] = process.argv.slice(2);
if (!marker || !release) throw new Error("Missing owned probe paths");
writeFileSync(marker, String(process.pid));
// Keep the owned leader alive after TERM so the caller must await and, if needed, escalate cleanup.
process.on("SIGTERM", () => writeFileSync(`${marker}.term`, "received"));
const timer = setInterval(() => {
  if (existsSync(release)) clearInterval(timer);
}, 20);
