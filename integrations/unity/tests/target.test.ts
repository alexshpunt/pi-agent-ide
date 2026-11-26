import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEditor } from "#unity/target.ts";

const instances = [
  { projectPath: "C:\\games\\one", pid: 12, port: 7800, state: "ready", role: "main" },
  { projectPath: "C:\\games\\two", pid: 13, port: 7801, state: "ready", role: "main" },
];

void test("selects only the explicitly named ready project", () => {
  assert.equal(selectEditor("C:\\games\\two", instances).pid, 13);
  assert.throws(() => selectEditor("two", instances));
  assert.throws(() => selectEditor("C:\\games\\missing", instances));
});

void test("normalizes equivalent absolute Windows paths without accepting partial names", () => {
  assert.equal(selectEditor("c:/GAMES/one/", instances).pid, 12);
  assert.throws(() => selectEditor("C:games\\\\one", instances));
});
void test("supports absolute UNC project paths", () => {
  const unc = { ...instances[0], projectPath: "\\\\server\\share\\Unity" };
  assert.equal(selectEditor("\\\\SERVER\\share\\Unity", [unc]).pid, 12);
});
void test("rejects ambiguous and unavailable editors", () => {
  assert.throws(() => selectEditor("C:\\games\\one", [...instances, { ...instances[0], pid: 99 }]));
  assert.throws(() => selectEditor("C:\\games\\one", [{ ...instances[0], state: "busy" }]));
});
