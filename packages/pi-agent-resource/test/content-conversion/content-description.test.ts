import { expect, test } from "vitest";

import { renderContentDescription } from "pi-agent-resource";

test("renders ordered converter descriptions below a provider summary", () =>
{
    expect(renderContentDescription("Reads fixture sources.", [
        { id: "im`age", description: "Images." },
        { id: "text", description: "UTF-8 text." },
    ])).toBe([
        "Reads fixture sources.",
        "- `im\\`age` — Images.",
        "- `text` — UTF-8 text.",
    ].join("\n"));
});

test("hides providers without installed content descriptions", () =>
{
    expect(renderContentDescription("Reads fixture sources.", [])).toBeUndefined();
});
