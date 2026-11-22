import { describe, expect, test } from "vitest";

import { searchCallPolicy } from "./search-call-policy.ts";

describe("search call policy", () => {
  test.each(["matches", "presentation", "files"] as const)(
    "preserves explicit %s limits for both audiences",
    (kind) => {
      expect(searchCallPolicy(7, false, kind)).toEqual({
        limit: 7,
        audience: "agent",
        uncappedFiles: false,
      });
      expect(searchCallPolicy(7, true, kind)).toEqual({
        limit: 7,
        audience: "script",
        uncappedFiles: kind === "files",
      });
    },
  );

  test.each(["matches", "presentation", "files"] as const)(
    "keeps the %s default for direct calls and selects the script policy",
    (kind) => {
      expect(searchCallPolicy(undefined, false, kind)).toEqual({
        limit: undefined,
        audience: "agent",
        uncappedFiles: false,
      });
      expect(searchCallPolicy(undefined, true, kind)).toEqual({
        limit: kind === "matches" ? Number.MAX_SAFE_INTEGER : undefined,
        audience: "script",
        uncappedFiles: kind === "files",
      });
    },
  );
});
