import { afterEach, describe, expect, test } from "vitest";
import { multiplexingConfigured, sshRoute } from "./ssh-master.ts";
import { systemSshArguments } from "./ssh-transport.ts";

describe("multiplexingConfigured", () => {
  test("a configuration without ControlMaster or ControlPath leaves multiplexing to Pi", () => {
    expect(multiplexingConfigured("user user\ncontrolmaster false\ncontrolpersist no\n")).toBe(
      false,
    );
    expect(multiplexingConfigured("controlmaster false\ncontrolpath none\n")).toBe(false);
  });

  test("a user's ControlMaster or ControlPath stays in charge", () => {
    expect(multiplexingConfigured("controlmaster auto\ncontrolpath /tmp/s-%C\n")).toBe(true);
    expect(multiplexingConfigured("controlmaster false\ncontrolpath /home/u/.ssh/cm-abc\n")).toBe(
      true,
    );
    expect(multiplexingConfigured("controlmaster true\n")).toBe(true);
  });
});

describe("sshRoute", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  test("a Windows controller connects directly, because its OpenSSH cannot multiplex", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const route = await sshRoute({ id: "t", host: "unused-host", workspace: "/" }, 1000);
    expect(route.options).toEqual([]);
    expect(
      systemSshArguments({ id: "t", host: "unused-host", workspace: "/" }, "cmd", route.options),
    ).toEqual([
      "-T",
      "-o",
      "LogLevel=VERBOSE",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ClearAllForwardings=yes",
      "--",
      "unused-host",
      "cmd",
    ]);
  });

  test("route options precede the destination", () => {
    expect(
      systemSshArguments({ id: "t", host: "h", workspace: "/", configFile: "/c" }, "cmd", [
        "-o",
        "ControlPath=/tmp/s",
      ]).slice(-7),
    ).toEqual(["-F", "/c", "-o", "ControlPath=/tmp/s", "--", "h", "cmd"]);
  });
});
