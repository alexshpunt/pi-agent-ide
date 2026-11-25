import { expect, test } from "vitest";
import { stableLinearAssetLinks } from "#linear/asset-links.ts";

const asset = "https://uploads.linear.app/workspace/upload/file";

test.each([
  [`[file](<${asset}?signature=old>)`, `[file](<${asset}>)`],
  [`See ${asset}?signature=token. Next`, `See ${asset}. Next`],
  [`(See ${asset}?signature=token.)`, `(See ${asset}.)`],
  [`(${asset}?signature=token.)`, `(${asset}.)`],
  [`[file](${asset}?signature=token.)`, `[file](${asset})`],
  [`See ${asset}?signature=token, next`, `See ${asset}, next`],
  [`[file](<${asset}?signature=token.>)`, `[file](<${asset}>)`],
  [`![image](${asset}?signature=new)`, `![image](${asset})`],
  [`${asset}?signature=old&download=a%20b#part`, `${asset}?download=a%20b#part`],
  [`${asset}?download=a+b&signature=old&version=1`, `${asset}?download=a+b&version=1`],
  [`${asset}?version=1&signature=old#part`, `${asset}?version=1#part`],
  [`${asset}?signature=one&signature=two`, asset],
  [`Manifest URL${asset}?signature=old. Task follows.`, `Manifest URL${asset}. Task follows.`],
  [`Final asset${asset}?signature=old SHA256`, `Final asset${asset} SHA256`],
  [`not-a-url${asset}?signature=old`, `not-a-url${asset}`],
  [`${asset}?version=1#signature=keep`, `${asset}?version=1#signature=keep`],
])("removes only the asset signature without rewriting Markdown: %s", (input, expected) => {
  expect(stableLinearAssetLinks(input)).toBe(expected);
  expect(stableLinearAssetLinks(expected)).toBe(expected);
});

test.each([
  "https://example.com/file?signature=keep",
  `<https://example.com/?return=${asset}?signature=keep>`,
  `https://example.com/?return=${asset}?signature=keep`,
  `https://example.com/(return=${asset}?signature=keep)`,
  `https://example.com/[${asset}?signature=keep]`,
  "https://uploads.linear.app.evil/file?signature=keep",
  "https://uploads.linear.app:443/file?signature=keep",
  "http://uploads.linear.app/file?signature=keep",
  `${asset}?other_signature=keep`,
  `${asset}?signature_name=keep`,
  `${asset}?download=signature%3Dkeep`,
  "Ordinary text: signature=keep",
])("does not ignore changes outside Linear's asset signature: %s", (input) => {
  expect(stableLinearAssetLinks(input)).toBe(input);
});

test("keeps the whole paragraph and distinct assets", () => {
  const input = `Before [one](<${asset}?signature=old>). After [two](${asset}-two?signature=new).\n`;
  expect(stableLinearAssetLinks(input)).toBe(
    `Before [one](<${asset}>). After [two](${asset}-two).\n`,
  );
});
