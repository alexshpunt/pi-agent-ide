import { afterEach, expect, test, vi } from "vitest";
import { createDiagnosticDelivery } from "#src/core/diagnostic-delivery.js";

afterEach(() => vi.useRealTimers());

test("collects a burst once at the first deadline, without sliding the window", async () => {
  vi.useFakeTimers();
  const flush = vi.fn(async (_cwd: string) => {});
  const delivery = createDiagnosticDelivery(flush, 5000);
  delivery.schedule("/project");
  await vi.advanceTimersByTimeAsync(4000);
  delivery.schedule("/project");
  expect(flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(flush).toHaveBeenCalledExactlyOnceWith("/project");
  delivery.schedule("/project");
  delivery.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  expect(flush).toHaveBeenCalledTimes(1);
});

test("retains each workspace and serializes delivery while more reports arrive", async () => {
  vi.useFakeTimers();
  const delivered: string[] = [];
  let release!: () => void;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = createDiagnosticDelivery(async (cwd) => {
    delivered.push(cwd);
    if (cwd === "/a") await active;
  }, 0);
  delivery.schedule("/a");
  delivery.schedule("/b");
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["/a"]);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["/a", "/b"]);
  delivery.dispose();
});
