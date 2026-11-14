import type { RoutedThread } from "../contracts/native-routing.js"
import { primerBlocks } from "../contracts/primer.js"
import type { ThreadEnvironment } from "../contracts/thread-environments.js"
import { CLOUD_MACHINE_INSTRUCTIONS, threadEnvironmentInstructions } from "../workspaces/index.js"
import type { ControlInstructions } from "./control-cadence.js"

/** Where Mako's note reads what it says for a conversation. */
export interface MakoNoteSources {
  cloudMachine: boolean
  /** The values the conversation's process started with. */
  launchedWith(conversationId: string): ThreadEnvironment | undefined
  /** The Local Control line of the binding's control session. */
  controlLine(bindingId: string): string | undefined
  /** Whether the conversation's harness takes Mako's blocks in a slot of its own (`makoInstructions`); undefined before it has one. */
  ownSlot(conversationId: string): boolean | undefined
  notices(conversationId: string): string[]
}

/**
 * The lines of Mako's note ahead of a prompt (`Dependencies.controlInstructions`).
 * A harness without a slot of its own hears the primer's blocks here, each a
 * standing line under its block's id, so they go on the note's cadence
 * (`standingLines`): whole to a process that hasn't heard them, then as they change.
 */
export function makoNote(sources: MakoNoteSources) {
  return (bindingId: string, conversationId: string, thread: Pick<RoutedThread, "role">): ControlInstructions => {
    const launched = sources.launchedWith(conversationId)
    const blocks = sources.ownSlot(conversationId) === false ? primerBlocks({ role: thread.role, noRecipe: launched?.recipe?.kind === "none", computer: true }) : []
    return {
      standing: {
        machine: sources.cloudMachine ? CLOUD_MACHINE_INSTRUCTIONS : undefined,
        control: sources.controlLine(bindingId),
        environment: launched && threadEnvironmentInstructions(launched, sources.cloudMachine ? "cloud" : "local"),
        ...Object.fromEntries(blocks.map((block) => [block.id, block.text])),
      },
      notices: sources.notices(conversationId),
    }
  }
}
