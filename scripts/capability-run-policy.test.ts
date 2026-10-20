import { expect, test } from "vitest";
import { accountStopReason } from "#capabilities/run-policy.ts";

test.each([
  "Your credit balance is too low",
  "Payment required",
  "Extra usage is disabled",
  "Usage limit reached",
  "You've hit your limit · resets later",
  "Quota exceeded",
])("an account limit stops further paid attempts: %s", (error) => {
  expect(accountStopReason({ status: "model_error", reasons: [error] })).toBe("account-limit");
});

test.each([
  "Access token expires before the bounded attempt and no-refresh safety window finish",
  "OAuth token has expired",
  "Invalid authentication",
  "Please run /login",
])("an unusable login stops the batch without refreshing: %s", (error) => {
  expect(accountStopReason({ status: "unavailable", reasons: [error] })).toBe("authentication");
});

test.each(["pass", "route_failed", "outcome_failed"])(
  "ordinary tool or task content does not become an account failure (%s)",
  (status) => {
    expect(accountStopReason({ status, reasons: ["billing"] })).toBeUndefined();
  },
);

test("server overload and missing local prerequisites are not billing failures", () => {
  expect(
    accountStopReason({ status: "model_error", reasons: ["Our servers are currently overloaded"] }),
  ).toBeUndefined();
  expect(
    accountStopReason({ status: "unavailable", reasons: ["Missing prerequisite: jq"] }),
  ).toBeUndefined();
});
