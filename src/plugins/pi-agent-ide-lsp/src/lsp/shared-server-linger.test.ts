import { expect, test } from "vitest";

import {
  DEFAULT_SHARED_SERVER_LINGER_MS,
  SHARED_SERVER_LINGER_ENVIRONMENT,
  sharedServerLingerMs,
} from "./shared-servers.ts";

test("the environment overrides the shared server linger with whole milliseconds", () => {
  expect(sharedServerLingerMs({})).toBe(DEFAULT_SHARED_SERVER_LINGER_MS);
  expect(sharedServerLingerMs({ [SHARED_SERVER_LINGER_ENVIRONMENT]: "5000" })).toBe(5000);
  expect(sharedServerLingerMs({ [SHARED_SERVER_LINGER_ENVIRONMENT]: "0" })).toBe(0);
  for (const invalid of ["", "-1", "1.5", "soon"])
    expect(sharedServerLingerMs({ [SHARED_SERVER_LINGER_ENVIRONMENT]: invalid })).toBe(
      DEFAULT_SHARED_SERVER_LINGER_MS,
    );
});
