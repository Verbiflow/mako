import { defineRule } from "@oxlint/plugins";

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);
/** The one pool every other goes through. */
const HELPER = /(^|[\\/])packages[\\/]protocol[\\/]src[\\/]map-limit\.ts$/;

interface Node {
  type: string;
  [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

/** Whether `node` holds a loop of its own, outside any function inside it. */
function loops(node: Node): boolean {
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!isNode(child) || FUNCTIONS.has(child.type)) continue;
      if (LOOPS.has(child.type) || loops(child)) return true;
    }
  }
  return false;
}

function member(node: Node | undefined, object: string, property: string): boolean {
  if (node?.type !== "MemberExpression" || node.computed) return false;
  const target = node.object;
  const name = node.property;
  return isNode(target) && target.type === "Identifier" && target.name === object &&
    isNode(name) && name.type === "Identifier" && name.name === property;
}

/**
 * A pool of lanes written by hand, `Promise.all(Array.from({ length }, lane))` with each lane pulling work in a loop,
 * rejects at the first lane's error while the other lanes go on: a restore said it failed with writes still landing,
 * and a move's rollback read a file a write then replaced. `mapLimit` (`@mako/protocol/map-limit`) starts nothing new
 * after a failure and rejects once what started has settled.
 */
export const noBarePromiseLanesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow hand-written Promise.all lane pools; use mapLimit from @mako/protocol/map-limit.",
    },
    messages: {
      lanes:
        "Use `mapLimit` from @mako/protocol/map-limit: a pool of lanes under Promise.all rejects at the first error while the other lanes still run.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (HELPER.test(context.filename)) return;
        if (!member(node.callee as Node, "Promise", "all") && !member(node.callee as Node, "Promise", "allSettled")) return;
        const pool = node.arguments[0] as Node | undefined;
        if (pool?.type !== "CallExpression" || !member(pool.callee as Node, "Array", "from")) return;
        const [shape, lane] = pool.arguments as Node[];
        if (shape?.type !== "ObjectExpression" || !lane) return;
        const sized = (shape.properties as Node[]).some((property) =>
          property.type === "Property" && isNode(property.key) && property.key.type === "Identifier" && property.key.name === "length");
        if (!sized) return;
        // A lane named elsewhere is a worker by its shape; one written in place is a lane when it loops over shared work.
        // One that takes its slot (`(_, index) =>`) is that slot's own worker, not one of a pool.
        const ownSlot = Array.isArray(lane.params) && lane.params.length > 0
        if (lane.type === "Identifier" || (FUNCTIONS.has(lane.type) && !ownSlot && isNode(lane.body) && loops(lane.body)))
          context.report({ node, messageId: "lanes" });
      },
    };
  },
});
