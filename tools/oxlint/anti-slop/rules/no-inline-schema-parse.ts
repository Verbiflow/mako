import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

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

function resolveVariable(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Whether `identifier` is zod itself: imported from `zod` (or a path of it) under any name, `z`, `zod` or another. */
function isZod(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable === null) return false;
  return variable.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") return false;
    const source = definition.parent.source.value;
    return source === "zod" || source.startsWith("zod/");
  });
}

/** Whether `node` builds a zod schema where it stands: a chain of calls that starts at zod's own builder. */
function builtHere(sourceCode: SourceCode, node: unknown): boolean {
  let current = node;
  while (current && typeof current === "object" && "type" in current) {
    if (current.type === "CallExpression" && "callee" in current) {
      current = current.callee;
      continue;
    }
    if (current.type === "MemberExpression" && "object" in current) {
      const object = current.object;
      if (object && typeof object === "object" && "type" in object && object.type === "Identifier") {
        // SAFETY: an Identifier read as an object of a member expression is a reference to a binding.
        return isZod(sourceCode, object as ESTree.IdentifierReference);
      }
      current = object;
      continue;
    }
    return false;
  }
  return false;
}

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

/**
 * Whether the parse at `node` runs once for each build of the schema made in `owner`: no function or loop between
 * them. A schema built once and then parsed in a loop, or by a closure that outlives the build, is made once for many
 * parses, as a module's is.
 */
function oncePerBuild(node: { parent?: unknown }, owner: unknown): boolean {
  let current = node.parent;
  while (current && typeof current === "object" && "type" in current) {
    if (current === owner) return true;
    if (FUNCTIONS.has(String(current.type)) || LOOPS.has(String(current.type))) return false;
    current = "parent" in current ? current.parent : undefined;
  }
  return false;
}

/** The function `node` is in, nearest first. */
function functionOf(node: { parent?: unknown }): unknown {
  let current = node.parent;
  while (current && typeof current === "object" && "type" in current) {
    if (FUNCTIONS.has(String(current.type))) return current;
    current = "parent" in current ? current.parent : undefined;
  }
  return undefined;
}

/**
 * A local that holds a schema built in a function and parsed once per build in that same function (`const S =
 * z.object(…)`, then `S.parse(v)`): built each call as surely as one parsed where it's built.
 */
function builtInFunction(sourceCode: SourceCode, identifier: ESTree.IdentifierReference, call: { parent?: unknown }): boolean {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable === null) return false;
  return variable.defs.some((definition) => {
    if (definition.type !== "Variable" || definition.node.type !== "VariableDeclarator" || definition.node.init === null) return false;
    const owner = functionOf(definition.node);
    return owner !== undefined && oncePerBuild(call, owner) && builtHere(sourceCode, definition.node.init);
  });
}

/**
 * Ban a zod schema built inside a function and parsed there, directly or through a local: zod compiles each new schema,
 * so one built per call costs that compile every time, on whatever thread runs it. A live batch read that way built two
 * schemas a batch on the host's loop, and a bench that did held its thread 50 to 110 ms at a time.
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
        const receiver = node.callee.object;
        const sourceCode = context.sourceCode;
        const inline = inFunction(node) && builtHere(sourceCode, receiver);
        const local = receiver.type === "Identifier" && builtInFunction(sourceCode, receiver, node);
        if (inline || local) context.report({ node, messageId: "inline" });
      },
    };
  },
});
