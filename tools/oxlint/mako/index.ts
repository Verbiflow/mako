import { eslintCompatPlugin } from "@oxlint/plugins";

import { heavyPackagesRule } from "./rules/heavy-packages.ts";
import { noBarePromiseLanesRule } from "./rules/no-bare-promise-lanes.ts";
import { noHarnessNamesRule } from "./rules/no-harness-names.ts";

/** Rules that keep Mako's own architecture honest, beside the generic anti-slop set. */
const makoPlugin = eslintCompatPlugin({
  meta: { name: "mako" },
  rules: {
    "heavy-packages": heavyPackagesRule,
    "no-bare-promise-lanes": noBarePromiseLanesRule,
    "no-harness-names": noHarnessNamesRule,
  },
});

export default makoPlugin;
