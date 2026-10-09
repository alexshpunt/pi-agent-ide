import { expect, test } from "vitest";
import { sshFailureCode } from "./ssh-transport.js";

test("exit status alone cannot diagnose a missing remote Python dependency", () => {
  expect(sshFailureCode(127, "")).toBe("TRANSPORT_FAILED");
  expect(sshFailureCode(127, "remote worker stopped")).toBe("TRANSPORT_FAILED");
  expect(sshFailureCode(127, "bash: line 1: python3: command not found\n")).toBe(
    "DEPENDENCY_UNAVAILABLE",
  );
  expect(sshFailureCode(127, "sh: python3: not found\n")).toBe("DEPENDENCY_UNAVAILABLE");
});
