import { afterEach, expect, test, vi } from "vitest";

import {
  forgetReloadResource,
  retainReloadResource,
  takeReloadResource,
} from "#src/core/reload-resource-store.js";

const key = "reload-resource-store-test";

// Each call builds a distinct class from identical source, like Pi reloading an unchanged module.
const loadOwnerClass = () =>
  class Owner {
    readonly dispose = vi.fn();
  };
const Owner = loadOwnerClass();

class ChangedOwner {
  readonly dispose = vi.fn();
  changedContract(): void {}
}

afterEach(() => {
  takeReloadResource(key, Owner);
});

test("transfers a retained live owner exactly once", () => {
  const owner = new Owner();
  retainReloadResource(key, owner);

  expect(takeReloadResource(key, Owner)).toBe(owner);
  expect(takeReloadResource(key, Owner)).toBeUndefined();
});

test("transfers an owner across reloaded classes with the same source", () => {
  const owner = new (loadOwnerClass())();
  retainReloadResource(key, owner);

  expect(takeReloadResource(key, loadOwnerClass())).toBe(owner);
  expect(owner.dispose).not.toHaveBeenCalled();
});

test("disposes an owner left by changed code instead of transferring it", async () => {
  const owner = new ChangedOwner();
  retainReloadResource(key, owner);

  expect(takeReloadResource(key, Owner)).toBeUndefined();
  await vi.waitFor(() => expect(owner.dispose).toHaveBeenCalledOnce());
  expect(takeReloadResource(key, ChangedOwner)).toBeUndefined();
});

test("forgets only the expected retained owner", () => {
  const owner = new Owner();
  retainReloadResource(key, owner);

  forgetReloadResource(key, new Owner());
  expect(takeReloadResource(key, Owner)).toBe(owner);

  retainReloadResource(key, owner);
  forgetReloadResource(key, owner);
  expect(takeReloadResource(key, Owner)).toBeUndefined();
});
