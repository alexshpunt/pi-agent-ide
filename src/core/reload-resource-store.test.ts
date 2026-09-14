import { afterEach, expect, test } from "vitest";

import {
  forgetReloadResource,
  retainReloadResource,
  takeReloadResource,
} from "#src/core/reload-resource-store.js";

const key = "reload-resource-store-test";

afterEach(() => {
  const retained = takeReloadResource(key);
  if (retained !== undefined) forgetReloadResource(key, retained);
});

test("transfers a retained live owner exactly once", () => {
  const owner = { live: true };
  retainReloadResource(key, owner);

  expect(takeReloadResource(key)).toBe(owner);
  expect(takeReloadResource(key)).toBeUndefined();
});

test("forgets only the expected retained owner", () => {
  const owner = { id: 1 };
  retainReloadResource(key, owner);

  forgetReloadResource(key, { id: 1 });
  expect(takeReloadResource(key)).toBe(owner);

  retainReloadResource(key, owner);
  forgetReloadResource(key, owner);
  expect(takeReloadResource(key)).toBeUndefined();
});
