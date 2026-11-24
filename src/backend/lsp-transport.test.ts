import { expect, test } from "vitest";
import { createSshLspTransport } from "./lsp-transport.ts";
import { SshBackendRegistry } from "./registry.ts";

test.each([
  {
    target: { id: "fixture", host: "fixture", workspace: "/C:/work", os: "windows" as const },
    source: "ssh://fixture/C:/work/a%20%25%23%C3%A9.ts",
    wire: "file:///C:/work/a%20%25%23%C3%A9.ts",
    native: "C:\\work\\a %#é.ts",
    watches: false,
    returned: "file:///c%3A/work/a%20%25%23%C3%A9.ts",
  },
  {
    target: { id: "fixture", host: "fixture", workspace: "/work" },
    source: "ssh://fixture/work/a%20%25%23%C3%A9.ts",
    wire: "file:///work/a%20%25%23%C3%A9.ts",
    native: "/work/a %#é.ts",
    watches: true,
    returned: "file:///work/a%20%25%23%C3%A9.ts",
  },
])(
  "maps file URIs using the SSH target's path rules",
  ({ target, source, wire, returned, native, watches }) => {
    const transport = createSshLspTransport(new SshBackendRegistry([target]), source);
    expect(transport.toServerUri(source)).toBe(wire);
    expect(transport.fromServerUri(returned)).toBe(source);
    expect(transport.toServerPath?.(source)).toBe(native);
    expect(transport.fromServerPath?.(native)).toBe(source);
    expect(Boolean(transport.fileWatchers)).toBe(watches);
    expect(() => transport.fromServerUri("file://another-host/other/path")).toThrow(TypeError);
  },
);
