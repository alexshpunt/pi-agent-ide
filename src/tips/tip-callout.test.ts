import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { TipCallout } from "./tip-callout.js";

const theme = {
  bold: (text: string): string => `\u001B[1m${text}\u001B[22m`,
  fg: (color: string, text: string): string => {
    const code = color === "accent" ? 36 : color === "dim" ? 2 : 90;
    return `\u001B[${code}m${text}\u001B[39m`;
  },
} as Theme;

test("renders a tip with an accent rail and clear content hierarchy", () => {
  const callout = new TipCallout(
    {
      title: "Project setup",
      body: "Configure formatting, linting, LSP, search, and Git.\nRun /pi-agent-ide-doctor",
    },
    theme,
  );
  const rendered = callout.render(80);

  expect(rendered.map(stripTerminalSequences)).toEqual([
    "│ PI AGENT IDE · Project setup",
    "│ Configure formatting, linting, LSP, search, and Git.",
    "│ Run /pi-agent-ide-doctor",
  ]);
  expect(rendered.every((line) => line.includes("\u001B[36m│\u001B[39m"))).toBe(true);
  expect(rendered[2]).toContain("\u001B[36m\u001B[1m/pi-agent-ide-doctor");
});

test("keeps rendering safe when no content column is available", () => {
  const callout = new TipCallout({ title: "Title", body: "Body" }, theme);

  expect(callout.render(0)).toEqual([]);
  expect(callout.render(1).map(stripTerminalSequences)).toEqual(["│"]);
  expect(callout.render(2).map(stripTerminalSequences)).toEqual(["│ "]);
});

test("wraps every callout row inside a narrow terminal while keeping the rail", () => {
  const callout = new TipCallout(
    {
      title: "A longer project setup title",
      body: "A deliberately long explanation that needs to wrap cleanly.",
    },
    theme,
  );
  const rendered = callout.render(24);
  const plain = rendered.map(stripTerminalSequences);

  expect(rendered.length).toBeGreaterThan(3);
  expect(plain.every((line) => line.startsWith("│ "))).toBe(true);
  expect(rendered.every((line) => visibleWidth(line) <= 24)).toBe(true);
  expect(plain.map((line) => line.slice(2)).join(" ")).toContain("long explanation");
});
