import { expect, test } from "vitest";

import { debuggerEvaluationFromResult } from "#src/plugins/pi-agent-ide-debugger/src/ui.js";

test("extracts an evaluation from semantic action metadata", () => {
  expect(
    debuggerEvaluationFromResult({
      metadata: {
        semanticAction: {
          evaluation: {
            expression: "subtotal - discount",
            result: "43",
            type: "number",
            variablesReference: 0,
          },
        },
      },
    }),
  ).toEqual({
    expression: "subtotal - discount",
    result: "43",
    type: "number",
    variablesReference: 0,
  });
});
