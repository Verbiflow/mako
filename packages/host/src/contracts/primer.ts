import { SHOW_MEDIA_LINE } from "@mako/sessions/turn-media"
import type { InstructionBlock } from "./mako-layer.js"
import type { RoutedThread } from "./native-routing.js"

/**
 * Mako's own words to every agent: which Mako tool to prefer (`routes`), and
 * the rules every Thread keeps (`policy`). Short on purpose. The `mako`
 * server's instructions and each tool's description are the rest.
 *
 * Both are the layer's instruction blocks (`INSTRUCTION_BLOCKS`). `layerOf`
 * puts them on a launch, and each adapter places that text in the append
 * slot it already has.
 */

/** What the blocks depend on, read from the Thread at launch. */
export interface PrimerThread {
  role: RoutedThread["role"]
  /** The project is known to have no recipe, so `app_start` can't run its app yet. Unknown reads as having one. */
  noRecipe: boolean
  /** The launch has Mako's `mako-computer` server. */
  computer: boolean
}

export const ROUTES_LEAD = "Prefer Mako's tool for this Thread. The mako server's instructions and each tool's description say the rest."

const APP_LINE = {
  recipe: "- Prefer app_start to start this Thread's app, app_probe to check that it answers, and port_holder to see who has a port: app_probe reads the app at its own address with the status, timing and a body excerpt, and says when it isn't running.",
  none: "- Prefer recipe_guide when this project has no recipe yet, so app_start can run its app: the guide is how to set one up. Prefer port_holder to see who has a port before you assume one is free.",
}

function routes(thread: PrimerThread): string {
  return [
    ROUTES_LEAD,
    "- Prefer worktree_move for a branch of this Thread (it takes the branch's name and a base), and worktree_status to see where you edit: Mako's Changes panel, pull request, app and checks follow only this Thread's checkouts. git worktree add, a new branch in the main checkout, and EnterWorktree are refused.",
    "- Prefer pull_request_open to open or update this branch's pull request, and pull_request_status for its checks, reviews and failed logs: they do what the Git sidebar's buttons do. Prefer pull_request_merge to merge; gh pr merge is refused.",
    thread.noRecipe ? APP_LINE.none : APP_LINE.recipe,
    "- Prefer agents_start for background, parallel, or another harness: an agent started from the shell isn't a Fin the person can open and steer, and nothing wakes you when it ends. A harness subagent is a quick look you wait for. After a start, end the turn; a report wakes you. When the next step needs the result, start with mode \"wait\".",
    ...thread.role === "apex" ? ["- Prefer agents_send for a message to one of your Fins, and agents_answer for the answer to its question: its work stays its own."] : [],
    ...thread.computer ? ["- Prefer the js tool on mako-computer for the browser and the screen: it shares targets and recordings with the person's view of this Thread."] : [],
    `- Prefer show for media the person should see: ${SHOW_MEDIA_LINE}`,
    "- Prefer thread_history for what this Thread already said and did.",
  ].join("\n")
}

export const POLICY = [
  "Merge a pull request or a branch only when the person asks, or when this Thread is on full access and merging is the next step of its work.",
  "Never put a token, key, password or other secret in your output, a commit, or a report.",
  "Report only what you ran and saw. Say what wasn't run or verified.",
].join("\n")

/** The blocks for one launch: `routes`, then `policy`. Both are once per session, then again when the text changes. */
export function primerBlocks(thread: PrimerThread): InstructionBlock[] {
  return [{ id: "routes", text: routes(thread) }, { id: "policy", text: POLICY }]
}

/** The blocks as one text, for a harness that takes them in one append slot. */
export function primerText(thread: PrimerThread): string {
  return primerBlocks(thread).map((block) => block.text).join("\n\n")
}

/** Mako's Fin as a subagent a harness can declare: asking it for "a subagent" for durable work starts one. */
export const FIN_SUBAGENT = {
  name: "fin",
  description: "Background, parallel, durable or writing work, as a Mako Fin the person can open and steer. Use it instead of a general-purpose subagent for anything but a quick read-only look you wait for.",
  prompt: "You hand this work to Mako. Call agents_start once, with the task as the brief: its objective, what done means, its boundaries, and anything the task names. Don't do the work yourself and don't call another tool. Return what agents_start answered: the Fin's name and state.",
  tools: ["agents_start"],
} as const
