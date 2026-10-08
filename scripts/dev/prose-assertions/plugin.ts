import { definePlugin } from "@oxlint/plugins";
import { noProseAssertionsRule } from "./rule.ts";

/** Advisory plugin. It is deliberately absent from the normal lint config. */
export default definePlugin({
  meta: { name: "prose-experiment" },
  rules: { "no-prose-assertions": noProseAssertionsRule },
});
