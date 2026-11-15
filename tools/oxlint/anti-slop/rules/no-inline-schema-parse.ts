import { defineRule } from "@oxlint/plugins";

const PARSES = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** Whether `node` is inside a function body: run each time it's called, not once as a module loads. */
function inFunction(node: { parent?: unknown }): boolean {
  let current = node.parent;
  while (current && typeof current === "object" && "type" in current) {
    if (FUNCTIONS.has(String(current.type))) return true;
    current = "parent" in current ? current.parent : undefined;
  }
  return false;
}

/** Whether `node` is a zod schema built where it stands: a chain of calls that starts at `z.<builder>(…)`. */
function builtHere(node: unknown): boolean {
  let current = node;
  while (current && typeof current === "object" && "type" in current) {
    if (current.type === "CallExpression" && "callee" in current) {
      current = current.callee;
      continue;
    }
    if (current.type === "MemberExpression" && "object" in current) {
      const object = current.object;
      if (object && typeof object === "object" && "type" in object && object.type === "Identifier" && "name" in object && object.name === "z") return true;
      current = object;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Ban a zod schema built inside a function and parsed there: zod compiles each new schema, so one built per call costs
 * that compile every time, on whatever thread runs it. A live batch read that way built two schemas a batch on the
 * host's loop, and a bench that did held its thread 50 to 110 ms at a time.
 */
export const noInlineSchemaParseRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow parsing with a zod schema built inside a function; make the schema once at module scope.",
    },
    messages: {
      inline:
        "This schema is built each time the function runs, and zod compiles each new one. Make it once at module scope and parse with that.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
        if (node.callee.property.type !== "Identifier" || !PARSES.has(node.callee.property.name)) return;
        if (!builtHere(node.callee.object) || !inFunction(node)) return;
        context.report({ node, messageId: "inline" });
      },
    };
  },
});
