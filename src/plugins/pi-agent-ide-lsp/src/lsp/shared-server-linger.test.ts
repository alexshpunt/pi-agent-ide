import { expect, test } from "vitest";

import { SHARED_SERVER_LINGER_ENVIRONMENT, sharedServerLingerOverride } from "./shared-servers.ts";

test("the environment sets the shared server linger in whole milliseconds", () => {
  expect(sharedServerLingerOverride({})).toBeUndefined();
  expect(sharedServerLingerOverride({ [SHARED_SERVER_LINGER_ENVIRONMENT]: "5000" })).toBe(5000);
  expect(sharedServerLingerOverride({ [SHARED_SERVER_LINGER_ENVIRONMENT]: "0" })).toBe(0);
  for (const invalid of ["", "-1", "1.5", "soon"])
    expect(
      sharedServerLingerOverride({ [SHARED_SERVER_LINGER_ENVIRONMENT]: invalid }),
    ).toBeUndefined();
});
