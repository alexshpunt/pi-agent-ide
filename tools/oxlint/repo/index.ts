import { eslintCompatPlugin } from "@oxlint/plugins";

import { noParentPathsRule } from "./rules/no-parent-paths.ts";

/** Repository-specific rules maintained as part of this repository. */
const repoPlugin = eslintCompatPlugin({
  meta: { name: "repo" },
  rules: {
    "no-parent-paths": noParentPathsRule,
  },
});

export default repoPlugin;
