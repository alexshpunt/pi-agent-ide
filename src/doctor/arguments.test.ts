import { expect, test } from "vitest";
import { parseDoctorArguments } from "./arguments.js";

test("Doctor keeps local cwd without a source and binds apply flags to the explicit SSH project", () => {
  expect(parseDoctorArguments("--no-apply", "/controller")).toEqual({
    cwd: "/controller",
    flags: new Set(["--no-apply"]),
  });
  expect(
    parseDoctorArguments("--apply ssh://fixture/project%20name --agent", "/controller"),
  ).toEqual({ cwd: "ssh://fixture/project%20name", flags: new Set(["--apply", "--agent"]) });
  expect(() =>
    parseDoctorArguments("ssh://one/project ssh://two/project --apply", "/controller"),
  ).toThrow("Use /pi-agent-ide-doctor");
  expect(() => parseDoctorArguments("--apply --no-apply", "/controller")).toThrow("not both");
  expect(() => parseDoctorArguments("--aply", "/controller")).toThrow("Use /pi-agent-ide-doctor");
});
