import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

// A fresh Node process observes real module resolution: the test runner's module cache
// already holds the Pi package, so only a new process shows what a cold consumer loads.
const probe = String.raw`
import { registerHooks } from "node:module";

let piCodingAgentLoaded = false;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent") piCodingAgentLoaded = true;
    return next(specifier, context);
  },
});

const { createImageContentConverter } = await import(process.argv[1]);
const converter = createImageContentConverter();
const nonImages = [
  { source: "archive.zip", bytes: Buffer.from("504b0304140000000800", "hex") },
  { source: "paper.pdf", bytes: Buffer.from("%PDF-1.7\n", "ascii") },
  { source: "notes.txt", bytes: Buffer.from("plain text\n", "utf8") },
  { source: "broken.png", bytes: Buffer.from("89504e470d0a1a0a", "hex") },
];
const nonImageOutcomes = [];
for (const input of nonImages) {
  nonImageOutcomes.push((await converter.tryConvert(input, {})).kind);
}
const loadedAfterNonImages = piCodingAgentLoaded;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const imageOutcome = (await converter.tryConvert({ source: "pixel.png", bytes: png }, {})).kind;
console.log(JSON.stringify({ nonImageOutcomes, loadedAfterNonImages, imageOutcome, loadedAfterImage: piCodingAgentLoaded }));
`;

// The probe loads the Pi package once for the image case, which takes seconds on a busy machine.
test(
  "a cold process loads the Pi package only for a supported image",
  { timeout: 60_000 },
  async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "--eval",
      probe,
      import.meta.resolve("pi-agent-image"),
    ]);

    expect(JSON.parse(stdout)).toEqual({
      nonImageOutcomes: ["not-handled", "not-handled", "not-handled", "failed"],
      loadedAfterNonImages: false,
      imageOutcome: "converted",
      loadedAfterImage: true,
    });
  },
);
