import { expect, test } from "vitest";
import { mapLspUris } from "./owner-transport.js";

const map = (uri: string) => uri.replace("file:///", "ssh://alpha/");

test("maps locations, workspace edits and related diagnostic documents without touching text", () => {
  const input = {
    location: { uri: "file:///srv/input.ts" },
    links: [{ targetUri: "file:///srv/target.ts" }],
    documentChanges: [
      { textDocument: { uri: "file:///srv/edit.ts" }, edits: [{ newText: "file:///literal" }] },
      { kind: "rename", oldUri: "file:///srv/old.ts", newUri: "file:///srv/new.ts" },
    ],
    changes: { "file:///srv/input.ts": [{ newText: "file:///literal" }] },
    relatedDocuments: { "file:///srv/related.ts": { items: [{ message: "file:///literal" }] } },
    text: "file:///literal",
    label: "file:///literal",
  };
  const result = mapLspUris(input, map);
  expect(result).toEqual({
    location: { uri: "ssh://alpha/srv/input.ts" },
    links: [{ targetUri: "ssh://alpha/srv/target.ts" }],
    documentChanges: [
      { textDocument: { uri: "ssh://alpha/srv/edit.ts" }, edits: [{ newText: "file:///literal" }] },
      { kind: "rename", oldUri: "ssh://alpha/srv/old.ts", newUri: "ssh://alpha/srv/new.ts" },
    ],
    changes: { "ssh://alpha/srv/input.ts": [{ newText: "file:///literal" }] },
    relatedDocuments: { "ssh://alpha/srv/related.ts": { items: [{ message: "file:///literal" }] } },
    text: "file:///literal",
    label: "file:///literal",
  });
  expect(input.location.uri).toBe("file:///srv/input.ts");
});

test("maps document link targets and relative-pattern base URIs", () => {
  expect(mapLspUris({ target: "file:///srv/input.ts", baseUri: "file:///srv" }, map)).toEqual({
    target: "ssh://alpha/srv/input.ts",
    baseUri: "ssh://alpha/srv",
  });
});
