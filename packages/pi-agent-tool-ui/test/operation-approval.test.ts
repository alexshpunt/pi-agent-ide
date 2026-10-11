import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import {
  createOperationApproval,
  confirmOperation,
  OPERATION_APPROVAL_EVENT,
  type OperationApprovalContext,
} from "pi-agent-tool-ui/operation-approval";

function fixture() {
  const bus = new EventEmitter();
  const events = {
    emit: vi.fn((name: string, data: unknown) => {
      bus.emit(name, data);
    }),
  };
  const service = createOperationApproval(events);
  bus.on(OPERATION_APPROVAL_EVENT, service.handle);
  return { service, events, bus };
}
function deferred() {
  let resolve!: (answer: boolean) => void;
  const promise = new Promise<boolean>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function context(
  confirm: OperationApprovalContext["ui"]["confirm"],
  mode: OperationApprovalContext["mode"] = "tui",
): OperationApprovalContext {
  return { mode, hasUI: mode === "tui" || mode === "rpc", ui: { confirm } };
}
const request = { title: "Confirm operation", message: "Delete exact fixture target" };

test.each([true, false])(
  "reports waiting before opening and clears after answer %s",
  async (answer) => {
    const { service, events } = fixture();
    const decision = deferred();
    const confirm = vi.fn(() => {
      expect(events.emit.mock.calls.at(-1)).toEqual([
        "herdr:blocked",
        { active: true, label: "Waiting for operation approval" },
      ]);
      return decision.promise;
    });
    const pending = confirmOperation(events, context(confirm), request);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(request.title, request.message, {
      signal: expect.any(AbortSignal) as unknown,
    });
    decision.resolve(answer);
    expect(await pending).toBe(answer);
    expect(events.emit.mock.calls.at(-1)).toEqual(["herdr:blocked", { active: false }]);
    service.dispose();
  },
);

test("serializes different callers without clearing the next terminal approval", async () => {
  const { service, events } = fixture();
  const first = deferred();
  const second = deferred();
  const a = vi.fn(() => first.promise);
  const b = vi.fn(() => second.promise);
  const pendingA = confirmOperation(events, context(a), request);
  const pendingB = confirmOperation(events, context(b), { ...request, message: "Another target" });
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
  first.resolve(true);
  expect(await pendingA).toBe(true);
  expect(b).toHaveBeenCalledOnce();
  expect(events.emit.mock.calls.filter(([name]) => name === "herdr:blocked")).toEqual([
    ["herdr:blocked", { active: true, label: "Waiting for operation approval" }],
  ]);
  second.resolve(false);
  expect(await pendingB).toBe(false);
  expect(events.emit.mock.calls.at(-1)).toEqual(["herdr:blocked", { active: false }]);
  service.dispose();
});

test("cancels a queued request without opening it or clearing the active wait", async () => {
  const { service, events } = fixture();
  const decision = deferred();
  const controller = new AbortController();
  const queued = vi.fn(async () => true);
  const active = confirmOperation(
    events,
    context(() => decision.promise),
    request,
  );
  const pending = confirmOperation(events, context(queued), {
    ...request,
    signal: controller.signal,
  });
  controller.abort();
  expect(await pending).toBe(false);
  expect(queued).not.toHaveBeenCalled();
  expect(events.emit.mock.calls.at(-1)).toEqual([OPERATION_APPROVAL_EVENT, expect.any(Object)]);
  decision.resolve(false);
  expect(await active).toBe(false);
  service.dispose();
});

test("abort ignores a late positive answer and releases the current dialog", async () => {
  const { service, events } = fixture();
  const decision = deferred();
  const controller = new AbortController();
  let dialogSignal!: AbortSignal;
  const pending = confirmOperation(
    events,
    context(async (_title, _message, options) => {
      if (options?.signal === undefined) throw Error("Dialog signal missing");
      dialogSignal = options.signal;
      return decision.promise;
    }),
    { ...request, signal: controller.signal },
  );
  controller.abort();
  expect(await pending).toBe(false);
  expect(dialogSignal.aborted).toBe(true);
  expect(events.emit.mock.calls.at(-1)).toEqual(["herdr:blocked", { active: false }]);
  decision.resolve(true);
  service.dispose();
});

test("disposal refuses both current and queued requests and is idempotent", async () => {
  const { service, events } = fixture();
  const decision = deferred();
  const queued = vi.fn(async () => true);
  const active = confirmOperation(
    events,
    context(() => decision.promise),
    request,
  );
  const pending = confirmOperation(events, context(queued), request);
  service.dispose();
  service.dispose();
  expect(await active).toBe(false);
  expect(await pending).toBe(false);
  expect(queued).not.toHaveBeenCalled();
  expect(
    events.emit.mock.calls.filter(
      ([name, value]) => name === "herdr:blocked" && !(value as { active: boolean }).active,
    ),
  ).toHaveLength(1);
  decision.resolve(true);
});

test("a broken status listener cannot change approval and a broken dialog fails closed", async () => {
  const { service, events, bus } = fixture();
  bus.on("herdr:blocked", () => {
    throw Error("header unavailable");
  });
  expect(
    await confirmOperation(
      events,
      context(async () => true),
      request,
    ),
  ).toBe(true);
  expect(
    await confirmOperation(
      events,
      context(async () => {
        throw Error("dialog failed");
      }),
      request,
    ),
  ).toBe(false);
  service.dispose();
});

test("headless, pre-aborted and missing-service calls do not open or mark a dialog", async () => {
  const { service, events } = fixture();
  const confirm = vi.fn(async () => true);
  const controller = new AbortController();
  controller.abort();
  expect(await confirmOperation(events, context(confirm, "print"), request)).toBe(false);
  expect(
    await confirmOperation(events, context(confirm), { ...request, signal: controller.signal }),
  ).toBe(false);
  expect(await confirmOperation({ emit() {} }, context(confirm), request)).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(events.emit).not.toHaveBeenCalled();
  service.dispose();
});

test("RPC confirmation still works without claiming a terminal wait", async () => {
  const { service, events } = fixture();
  expect(
    await confirmOperation(
      events,
      context(async () => true, "rpc"),
      request,
    ),
  ).toBe(true);
  expect(events.emit.mock.calls.filter(([name]) => name === "herdr:blocked")).toHaveLength(0);
  service.dispose();
});
