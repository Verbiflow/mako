import { SHOW_MEDIA_LINE } from "@mako/sessions/turn-media"
import { ORCHESTRATION_INSTRUCTIONS } from "./agent-tools.js"
import type { InstructionBlock } from "./mako-layer.js"
import { NATIVE_OVERRIDE } from "./native-calls.js"
import type { RoutedThread } from "./native-routing.js"

/**
 * Mako's standing words to every agent, each fact said once:
 * - `routes`: which Mako tool to prefer over a native route, and why.
 * - `policy`: the rules every Thread keeps.
 * - `MAKO_SERVER_INSTRUCTIONS`: what the `mako` server is, its words, and the
 *   rules of its tools the routes don't give, the Fins' first.
 * - the Thread environment line (`threadEnvironmentInstructions`): only this
 *   Thread's values, never a route.
 *
 * `routes` and `policy` are the layer's instruction blocks
 * (`INSTRUCTION_BLOCKS`). `layerOf` puts them on a launch, and each adapter
 * places that text in the append slot it already has. A harness that never
 * shows the model the server's instructions (Devin), or that Mako serves
 * without them (Codex, whose tool lookups repeat them on every entry), hears
 * them as the `server` block instead (`serverBlock`).
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
  recipe: "- Prefer app_start to start this Thread's app, never a server started by hand: its processes stay this Thread's and outlive your turn. app_check runs the recipe's checks, app_probe checks that the app answers (status, timing and a body excerpt, or that it isn't running), and port_holder says who has a port before you assume it's free or stop anything. A change to how the project installs, starts or is checked updates the recipe in the same turn: recipe_save, then recipe_publish once it works.",
  none: "- Prefer recipe_guide when this project has no recipe yet, so app_start can run its app: the guide is how to set one up. Prefer port_holder to see who has a port before you assume it's free or stop anything.",
}

function routes(thread: PrimerThread): string {
  return [
    ROUTES_LEAD,
    "- Prefer worktree_move for a branch of this Thread (it takes the branch's name and a base, and moves only this Thread's own changes, so others' work in the checkout is no reason not to), and worktree_status to see where you edit: Mako's Changes panel, pull request, app and checks follow only this Thread's checkouts. git worktree add, a new branch in the main checkout, and EnterWorktree are refused; never copy the checkout either.",
    "- Prefer pull_request_open to open or update this branch's pull request, and pull_request_status for its checks, reviews and failed logs: they do what the Git sidebar's buttons do. Prefer pull_request_merge to merge; gh pr merge is refused.",
    thread.noRecipe ? APP_LINE.none : APP_LINE.recipe,
    "- Prefer agents_start for background, parallel, or another harness: an agent started from the shell isn't a Fin the person can open and steer, and nothing wakes you when it ends.",
    ...thread.computer ? ["- Prefer the js tool on mako-computer for the browser and the screen: it shares targets and recordings with the person's view of this Thread."] : [],
    `- Prefer show for media the person should see: ${SHOW_MEDIA_LINE}`,
    "- Prefer thread_history for what this Thread, in any harness, and the threads it referenced already said and did, read whole, instead of guessing.",
  ].join("\n")
}

export const POLICY = [
  "Do this Thread's own Git work yourself with Mako's tools: moving onto its branch, bringing or putting back what a move left, committing, pushing, updating from main, and opening or updating its pull request. Never ask the person to do in the app what a tool does; ask them only for a decision that is theirs, with your question tool, or agents_report if you're a Fin.",
  "Merge a pull request or a branch only when the person asks, or when this Thread is on full access and merging is the next step of its work.",
  "Never put a token, key, password or other secret in your output, a commit, or a report.",
  "Report only what you ran and saw. Say what wasn't run or verified.",
  "Link files with ordinary Markdown links to their absolute path, optionally followed by :line, so the person can open them.",
].join("\n")

/**
 * What an agent reads about the `mako` server before calling any of its
 * tools. The Fins' rules come first: Grok shows a server's instructions only
 * up to about 2,047 characters. Routes the primer gives aren't repeated here.
 */
export const MAKO_SERVER_INSTRUCTIONS = [
  "Mako's tools for the Thread this Session belongs to. Each acts on this Thread only.",
  ORCHESTRATION_INSTRUCTIONS,
  "wait: to wait on your Fins, a pull request, an app check or a time, call wait and end your turn; Mako wakes you. Never poll or sleep.",
  `Mako refuses git worktree add, a new branch in the main checkout and gh pr merge; ${NATIVE_OVERRIDE} before one runs it anyway, never a worktree, and only when the Mako tool failed. Other native routes run with a note naming the better tool. Commit, push, diff and log stay plain Git.`,
  "thread_move: this Thread itself to the cloud, when the person asks. That's this Thread going on elsewhere, not new work for a Fin.",
  "Their words:",
  "- main checkout: the project's own folder, the user's.",
  "- worktree: a Git worktree Mako made for one Thread, on its own branch; worktree_* choose which checkout you edit in.",
  "- checkout: either; this Session edits in one.",
  "- project folder: several repositories as one project; its worktree has one per repository on the Thread's branch.",
  "- app: the project running from a checkout on this Thread's ports; app_* run and check it.",
  "- recipe: how every Thread of the project installs, starts and checks its app; recipe_* change it.",
  "- pull request: this branch's, with its checks, reviews and merge; pull_request_* read and act on it.",
].join("\n")

/** The server's instructions as a block, for a harness that doesn't read them from the server. */
export function serverBlock(): InstructionBlock {
  return { id: "server", text: MAKO_SERVER_INSTRUCTIONS }
}

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
