import { eslintCompatPlugin } from "@oxlint/plugins";

import noDualKeyAccess from "./rules/no-dual-key-access.ts";
import noIdentityPassthrough from "./rules/no-identity-passthrough.ts";
import noNonNullAssertionChain from "./rules/no-non-null-assertion-chain.ts";
import noReduceAsMap from "./rules/no-reduce-as-map.ts";
import noRedundantBooleanIf from "./rules/no-redundant-boolean-if.ts";
import noSortForExtremum from "./rules/no-sort-for-extremum.ts";
import noStringConcatInReduce from "./rules/no-string-concat-in-reduce.ts";

/** Selected ts-slop rules adapted to Oxlint's plugin API. */
const tsSlopPlugin = eslintCompatPlugin({
  meta: { name: "ts-slop" },
  rules: {
    "no-dual-key-access": noDualKeyAccess,
    "no-identity-passthrough": noIdentityPassthrough,
    "no-non-null-assertion-chain": noNonNullAssertionChain,
    "no-reduce-as-map": noReduceAsMap,
    "no-redundant-boolean-if": noRedundantBooleanIf,
    "no-sort-for-extremum": noSortForExtremum,
    "no-string-concat-in-reduce": noStringConcatInReduce,
  },
});

export default tsSlopPlugin;
