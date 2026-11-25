import type { NativeSearchClient } from "#axi/graphql.ts";

/** Fail if a test intended for another native operation reaches search. */
export const unexpectedSearch: NativeSearchClient["searchObjects"] = async () => {
  throw new Error("Unexpected native search in this fixture");
};
