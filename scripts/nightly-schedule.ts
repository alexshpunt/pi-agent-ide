import { pathToFileURL } from "node:url";

/** Return whether a UTC instant falls in Berlin's midnight hour. */
export function isBerlinMidnight(instant: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return hour === "00";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${isBerlinMidnight(new Date())}\n`);
}
