import { expect, test } from "vitest";

import {
    isContentConversionAttempt,
    isContentConverter,
    isContentConverterRegistration,
    isContentInput,
    isContentTarget,
} from "pi-agent-resource";

test("validates targets, inputs, outcomes, and registrations structurally", () =>
{
    const target = { provider: "web", capability: "read" };
    const converter = {
        id: "text",
        description: "UTF-8 text.",
        tryConvert()
        {
            throw new Error("validation must not invoke callbacks");
        },
    };

    expect(isContentTarget(target)).toBe(true);
    expect(isContentTarget({ provider: " ", capability: "read" })).toBe(false);
    expect(isContentTarget({ provider: "web", capability: "write" })).toBe(true);
    expect(isContentTarget({ provider: "web", capability: "edit" })).toBe(false);

    expect(isContentInput({ source: "https://example.test", bytes: new Uint8Array(0) })).toBe(true);
    expect(isContentInput({ source: "", bytes: new Uint8Array(0) })).toBe(false);
    expect(isContentInput({ source: "value", bytes: [] })).toBe(false);
    expect(isContentInput({ source: "value", bytes: new Uint8Array(0), mediaType: undefined })).toBe(false);

    expect(isContentConverter(converter)).toBe(true);
    expect(isContentConverter({
        id: "",
        description: "Text.",
        tryConvert()
        {},
    })).toBe(false);
    expect(isContentConverter({
        id: "text",
        tryConvert()
        {},
    })).toBe(false);
    expect(isContentConverter({
        id: "text",
        description: "   ",
        tryConvert()
        {},
    })).toBe(false);
    expect(isContentConverter({
        id: "text",
        description: "first\nsecond",
        tryConvert()
        {},
    })).toBe(false);
    expect(isContentConversionAttempt({
        kind: "converted",
        content: [{ type: "custom", kind: "fixture", data: 1 }],
    })).toBe(true);
    expect(isContentConversionAttempt({ kind: "converted", content: [] })).toBe(false);
    expect(isContentConversionAttempt({ kind: "failed" })).toBe(false);

    expect(isContentConverterRegistration({ target, converter, priority: -10 })).toBe(true);
    expect(isContentConverterRegistration({ target, converter, priority: Number.NaN })).toBe(false);
    expect(isContentConverterRegistration({ target, converter, priority: undefined })).toBe(false);
});

test("returns false for values that throw during inspection", () =>
{
    const value = new Proxy({}, {
        get()
        {
            throw new Error("unreadable");
        },
        getOwnPropertyDescriptor()
        {
            throw new Error("unreadable");
        },
    });

    expect(isContentTarget(value)).toBe(false);
    expect(isContentInput(value)).toBe(false);
    expect(isContentConverter(value)).toBe(false);
    expect(isContentConversionAttempt(value)).toBe(false);
    expect(isContentConverterRegistration(value)).toBe(false);
});
