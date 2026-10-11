import { expect, test } from "vitest";
import { probeNativeCodemodeRenderer, settingsSmokeGuard } from "./live-settings-skill.js";

test("startup probe records untouched native Codemode input", () => {
  expect(probeNativeCodemodeRenderer((_name, fallback) => fallback())).toEqual({
    nativeCodemodeUnchanged: true,
  });
});

test("startup probe rejects IDE alteration of native Codemode input", () => {
  expect(() =>
    probeNativeCodemodeRenderer((_name, fallback) => {
      const original = fallback();
      const renderCall = original.renderCall;
      if (renderCall === undefined) throw new Error("Missing test renderer");
      return {
        ...original,
        renderCall(_args, theme, context) {
          return renderCall({ code: "" }, theme, context);
        },
      };
    }),
  ).toThrow("IDE altered native Codemode script input");
});

const roots = ["/fixture/project", "/fixture/agent", "/source/ide"] as const;
const check = (tool: string, input: unknown) => settingsSmokeGuard(tool, input, ...roots);

test("allows isolated scope files and read-only IDE guidance", () => {
  expect(check("write", { path: ".pi/pi-agent-ide/extensions.json" })).toBeUndefined();
  expect(check("replace", { path: "/fixture/agent/pi-agent-ide/extensions.json" })).toBeUndefined();
  expect(
    check("read", { path: "/source/ide/skills/configure-agent-ide/SKILL.md" }),
  ).toBeUndefined();
  expect(check("read", { path: "docs:ide-settings" })).toBeUndefined();
  expect(check("search", { path: "docs:all" })).toBeUndefined();
});

test("blocks shell execution, external paths and source mutations", () => {
  expect(check("bash", { command: "pwd" })).toBeTypeOf("string");
  expect(check("write", { path: "/source/ide/src/config.ts" })).toBeTypeOf("string");
  expect(check("read", { path: "/personal/auth.json" })).toBeTypeOf("string");
  // oxlint-disable-next-line repo/no-parent-paths -- rejected fixture path, not a filesystem access
  expect(check("write", { path: "../outside.json" })).toBeTypeOf("string");
  expect(check("write", { path: "file:///outside/config.json" })).toBeTypeOf("string");
  expect(check("write", { path: "SEARCH#1234:1:line" })).toBeTypeOf("string");
  expect(check("read", { path: "https://example.com" })).toBeTypeOf("string");
});
