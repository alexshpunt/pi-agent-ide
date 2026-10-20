import { EventEmitter } from "node:events";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import {
  confirmOperation,
  createOperationApproval,
  OPERATION_APPROVAL_EVENT,
  type OperationApprovalRequest,
} from "pi-agent-tool-ui/operation-approval";

const request = {
  owner: "fixture",
  category: "delete",
  yoloSetting: "fixture-yolo",
  title: "Delete fixture?",
  message: "/fixture/one",
};

function fixture(allow = false) {
  const bus = new EventEmitter();
  const entries: SessionEntry[] = [];
  const select = vi.fn(async () => "Allow for session");
  const events = {
    emit(name: string, data: unknown) {
      bus.emit(name, data);
    },
  };
  const remember = vi.fn((value: OperationApprovalRequest) => {
    entries.push({
      type: "custom",
      id: String(entries.length),
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-agent-ide/operation-permission/v1",
      data: { owner: value.owner, category: value.category },
    });
  });
  const service = createOperationApproval(events, { isAllowed: async () => allow, remember });
  bus.on(OPERATION_APPROVAL_EVENT, service.handle);
  const context = {
    cwd: "/fixture",
    mode: "tui" as const,
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: { select },
  };
  return { service, events, context, entries, remember, select };
}

test("a remembered grant applies only to the same owner and category", async () => {
  const f = fixture();
  expect(await confirmOperation(f.events, f.context, request)).toBe(true);
  expect(await confirmOperation(f.events, f.context, { ...request, message: "/fixture/two" })).toBe(
    true,
  );
  expect(f.select).toHaveBeenCalledTimes(1);
  expect(f.remember).toHaveBeenCalledTimes(1);
  f.select.mockResolvedValue("Deny");
  expect(await confirmOperation(f.events, f.context, { ...request, category: "merge" })).toBe(
    false,
  );
  expect(await confirmOperation(f.events, f.context, { ...request, owner: "another" })).toBe(false);
  expect(f.select).toHaveBeenCalledTimes(3);
  f.service.dispose();
});

test("restored branch entries survive a service reload but another session does not inherit", async () => {
  const f = fixture();
  expect(await confirmOperation(f.events, f.context, request)).toBe(true);
  f.service.dispose();
  const restored = fixture();
  restored.entries.push(...f.entries);
  expect(await confirmOperation(restored.events, restored.context, request)).toBe(true);
  expect(restored.select).not.toHaveBeenCalled();
  const fresh = fixture();
  fresh.select.mockResolvedValue("Deny");
  expect(await confirmOperation(fresh.events, fresh.context, request)).toBe(false);
  expect(fresh.select).toHaveBeenCalledTimes(1);
  restored.service.dispose();
  fresh.service.dispose();
});

test.each(["Allow once", "Deny"])("%s does not save a session grant", async (answer) => {
  const f = fixture();
  f.select.mockResolvedValue(answer);
  expect(await confirmOperation(f.events, f.context, request)).toBe(answer === "Allow once");
  await confirmOperation(f.events, f.context, request);
  expect(f.select).toHaveBeenCalledTimes(2);
  expect(f.remember).not.toHaveBeenCalled();
  f.service.dispose();
});

test("configured permission works without UI and never marks a dialog as waiting", async () => {
  const f = fixture(true);
  const states: unknown[] = [];
  const beforeWait = (value: unknown) => states.push(value);
  // The bus is private to this fixture; capture emitted states through the public event facade.
  const emit = f.events.emit;
  f.events.emit = (name, data) => {
    if (name === "herdr:blocked") beforeWait(data);
    emit(name, data);
  };
  expect(
    await confirmOperation(f.events, { ...f.context, mode: "print", hasUI: false }, request),
  ).toBe(true);
  expect(f.select).not.toHaveBeenCalled();
  expect(states).toEqual([]);
  f.service.dispose();
});

test("cancelling a pending host policy refuses it without blocking the next operation", async () => {
  const f = fixture();
  const started = vi.fn();
  f.service.setPolicy(async (value) => {
    if (value.message === "blocked policy") {
      started();
      return new Promise<boolean>(() => {});
    }
    return true;
  });
  const controller = new AbortController();
  const pending = confirmOperation(f.events, f.context, {
    ...request,
    message: "blocked policy",
    signal: controller.signal,
  });
  const next = confirmOperation(f.events, f.context, request);
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
  controller.abort();
  expect(await pending).toBe(false);
  expect(await next).toBe(true);
  expect(f.select).not.toHaveBeenCalled();
  f.service.dispose();
}, 1000);
test("invalid host policy refuses rather than falling back to a permissive dialog", async () => {
  const f = fixture();
  f.service.setPolicy(async () => {
    throw new Error("Invalid saved configuration");
  });
  expect(await confirmOperation(f.events, f.context, request)).toBe(false);
  expect(f.select).not.toHaveBeenCalled();
  f.service.dispose();
});
test("cancellation cannot save a late Allow for session answer", async () => {
  const f = fixture();
  const controller = new AbortController();
  let answer!: (value: string) => void;
  f.select.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const pending = confirmOperation(f.events, f.context, { ...request, signal: controller.signal });
  await vi.waitFor(() => expect(f.select).toHaveBeenCalledOnce());
  controller.abort();
  expect(await pending).toBe(false);
  answer("Allow for session");
  await Promise.resolve();
  expect(f.remember).not.toHaveBeenCalled();
  f.service.dispose();
});
