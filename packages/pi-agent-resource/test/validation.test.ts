import { expect, test } from "vitest";

import { isAgentContent, isResource, isResourceResolutionAttempt, isResourceResolver } from "pi-agent-resource";

test("validates non-empty Pi and custom content", () =>
{
    expect(isAgentContent([{ type: "text", text: "" }])).toBe(true);
    expect(isAgentContent([{
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
        extensionField: true,
    }])).toBe(true);
    expect(isAgentContent([{ type: "custom", kind: "chart", data: undefined }])).toBe(true);

    expect(isAgentContent([])).toBe(false);
    expect(isAgentContent([{ type: "custom", kind: "", data: {} }])).toBe(false);
    expect(isAgentContent([{ type: "custom", kind: "chart" }])).toBe(false);
    expect(isAgentContent([{ type: "text", text: "value", textSignature: undefined }])).toBe(false);
    expect(isAgentContent(new Array(1))).toBe(false);
});

test("validates each resource capability shape", () =>
{
    expect(isResource({
        source: "read",
        read()
        {},
        extensionField: true,
    })).toBe(true);
    expect(isResource({
        source: "write",
        write()
        {},
    })).toBe(true);
    expect(isResource({
        source: "both",
        read()
        {},
        write()
        {},
    })).toBe(true);

    expect(isResource({ source: "none" })).toBe(false);
    expect(isResource({
        source: "",
        read()
        {},
    })).toBe(false);
    expect(isResource({ source: "invalid", read: true })).toBe(false);
    expect(isResource({
        source: "invalid",
        read()
        {},
        write: false,
    })).toBe(false);
    expect(isResource({
        source: "invalid",
        read()
        {},
        write: undefined,
    })).toBe(false);
});

test("validates resolvers and nested resolution attempts", () =>
{
    const resolver = {
        id: "fixture",
        tryResolve()
        {},
    };
    const resource = {
        source: "fixture",
        read()
        {},
    };

    expect(isResourceResolver(resolver)).toBe(true);
    expect(isResourceResolver({
        id: "",
        tryResolve()
        {},
    })).toBe(false);
    expect(isResourceResolutionAttempt({ kind: "not-handled", extra: true })).toBe(true);
    expect(isResourceResolutionAttempt({ kind: "resolved", resource })).toBe(true);
    expect(isResourceResolutionAttempt({ kind: "resolved", resource: { source: "invalid" } })).toBe(false);
    expect(isResourceResolutionAttempt({
        kind: "resolved",
        resource: {
            source: "invalid",
            read()
            {},
            write: undefined,
        },
    })).toBe(false);
    expect(isResourceResolutionAttempt({ kind: "failed", error: undefined })).toBe(true);
    expect(isResourceResolutionAttempt({ kind: "failed" })).toBe(false);
});

test("returns false when an unknown value throws during inspection", () =>
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

    expect(isAgentContent(value)).toBe(false);
    expect(isResource(value)).toBe(false);
    expect(isResourceResolver(value)).toBe(false);
    expect(isResourceResolutionAttempt(value)).toBe(false);
});
