import { randomInt } from "node:crypto"
import { THREAD_PORT_COUNT, THREAD_PORT_FIRST, THREAD_PORT_LAST } from "@mako/host/contracts/thread-environments"
import { portListening } from "@mako/host/workspaces/thread-environment"

/**
 * A free block of Thread ports for a test, from the range Mako's own Threads take theirs from. It's below every
 * system's ephemeral range (Linux's starts at 32768, macOS's at 49152): a block probed free at 43000 was handed to
 * an outbound connection before the test bound it, and `test-recipe-proof` failed EADDRINUSE on 43010 (#886, gate 12).
 * It starts at a random block, so tests running beside each other don't probe their way to the same one, and passes
 * over the blocks the test already holds.
 */
export async function freeThreadBlock(taken: readonly number[] = []): Promise<number> {
  const blocks = Math.floor((THREAD_PORT_LAST - THREAD_PORT_FIRST + 1) / THREAD_PORT_COUNT)
  const start = randomInt(blocks)
  for (let tried = 0; tried < blocks; tried += 1) {
    const base = THREAD_PORT_FIRST + ((start + tried) % blocks) * THREAD_PORT_COUNT
    if (taken.includes(base)) continue
    const busy = await Promise.all(Array.from({ length: THREAD_PORT_COUNT }, (_, index) => portListening(base + index)))
    if (!busy.some(Boolean)) return base
  }
  throw new Error("No block of Thread ports is free for the test")
}
