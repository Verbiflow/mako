import { eslintCompatPlugin } from "@oxlint/plugins";

import { noHarnessNamesRule } from "./rules/no-harness-names.ts";

/** Rules that keep Mako's own architecture honest, beside the generic anti-slop set. */
const makoPlugin = eslintCompatPlugin({
  meta: { name: "mako" },
  rules: {
    "no-harness-names": noHarnessNamesRule,
  },
});

export default makoPlugin;
