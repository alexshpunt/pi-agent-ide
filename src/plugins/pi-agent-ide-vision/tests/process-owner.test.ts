import { expect, test } from "vitest";
import { AgentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import {
  withRemoteProcessOwnership,
  type RemoteProcessMetadata,
} from "#src/plugins/pi-agent-ide-vision/src/vision.js";

const metadata: RemoteProcessMetadata = {
  pid: 123,
  parentPid: 1,
  command: "python3",
  started: "2026-01-01",
  identity: "boot:42",
  executable: "/usr/bin/python3",
  owned: false,
  host: "ssh",
  target: "fixture",
  resource: "process:ssh://fixture/123",
};

test("remote ownership requires the same target, PID and kernel lifetime from an active owned channel", () => {
  for (const [target, identity, owned, expected] of [
    ["fixture", "boot:42", true, true],
    ["fixture", "boot:43", true, false],
    ["other", "boot:42", true, false],
    ["fixture", undefined, true, false],
    ["fixture", "boot:42", false, false],
  ] as const) {
    const registry = new AgentIdeProcessRegistry();
    const remove = registry.add({
      id: "terminal",
      onDidChange: () => () => {},
      list: () => [
        {
          source: "shell:owned",
          kind: "terminal",
          title: "owned",
          description: "owned",
          status: "running",
          remote: { target, pid: 123, identity },
          owned,
          renderSummary: () => [],
          renderDetail: () => ({ render: () => [], invalidate: () => {} }),
          stop: () => Promise.resolve(),
        },
      ],
    });
    expect(withRemoteProcessOwnership(metadata, registry)).toMatchObject({
      owned: expected,
      ...(expected ? { source: "shell:owned" } : {}),
    });
    if (!expected) expect(withRemoteProcessOwnership(metadata, registry).source).toBeUndefined();
    remove();
    expect(withRemoteProcessOwnership(metadata, registry).owned).toBe(false);
  }
});
