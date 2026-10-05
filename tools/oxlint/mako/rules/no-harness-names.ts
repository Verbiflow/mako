import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineRule } from "@oxlint/plugins";

/** Where code may name a harness: its own folder, and the dev mock that stands in for the host. */
const OWNERS = [/\/electron\/providers\//, /\/src\/dev\//];
const CHECKED = [/\/src\//, /\/electron\//];

/**
 * Every harness's id and display name, read from the descriptor snapshot the
 * definitions generate (`scripts/harness-descriptors.ts`), so a new harness
 * is covered without editing this rule.
 */
function harnessNames(): ReadonlySet<string> {
  const source = readFileSync(join(process.cwd(), "src", "dev", "harness-descriptors.ts"), "utf8");
  const start = source.indexOf("= [");
  if (start === -1) throw new Error("src/dev/harness-descriptors.ts has no descriptor list; regenerate it");
  const names = new Set<string>();
  for (const match of source.slice(start).matchAll(/"(?:provider|displayName)": "([^"]+)"/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/**
 * Bans branching on a harness's name, and hand-kept lists of harnesses,
 * outside the harness's own folder. What differs between harnesses is a
 * declared field on its definition or descriptor; a name check is a list
 * someone must remember to extend when the next harness arrives.
 */
export const noHarnessNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow comparing against a harness's name or listing harnesses by hand outside its provider folder.",
    },
    messages: {
      comparison:
        "Don't branch on the harness `{{name}}`. Declare what differs on the harness definition (electron/providers/<harness>) and read it from the registry or the descriptor.",
      list:
        "Don't list harnesses by hand. Read them from the registry (`providerHost.harnesses`) or the descriptors, so the next harness appears here without an edit.",
    },
  },
  createOnce(context) {
    let names: ReadonlySet<string> | undefined;
    const checked = () => {
      const file = context.filename;
      return CHECKED.some((pattern) => pattern.test(file)) && !OWNERS.some((pattern) => pattern.test(file));
    };
    const harness = (node: { type: string; value?: unknown }): string | undefined => {
      if (node.type !== "Literal" || typeof node.value !== "string") return undefined;
      names ??= harnessNames();
      return names.has(node.value) ? node.value : undefined;
    };
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator) || !checked()) return;
        const name = harness(node.left) ?? harness(node.right);
        if (name) context.report({ node, messageId: "comparison", data: { name } });
      },
      SwitchCase(node) {
        if (!node.test || !checked()) return;
        const name = harness(node.test);
        if (name) context.report({ node, messageId: "comparison", data: { name } });
      },
      ArrayExpression(node) {
        if (!checked()) return;
        let count = 0;
        for (const element of node.elements) if (element && harness(element)) count += 1;
        if (count >= 2) context.report({ node, messageId: "list" });
      },
    };
  },
});
