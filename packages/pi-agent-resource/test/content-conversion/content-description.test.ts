import { expect, test } from "vitest";

import { renderContentDescription } from "pi-agent-resource";

test("hides providers without installed content descriptions", () => {
  expect(renderContentDescription("Reads fixture sources.", [])).toBeUndefined();
});
