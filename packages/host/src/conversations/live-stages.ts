import type { LiveBatch, LiveDriverEvent } from "../contracts/live-conversations.js"
import { topic } from "../base/topic.js"

/**
 * Where a message stands on its way from the call that sent it to its harness, said as it passes each point, so a
 * measurement (`npm run bench:vs-bare`) times every step between them without the host timing anything itself:
 * - `submit`: its model's settings are resolved and the sends ahead of it are in (`admitInOrder`);
 * - `admitted`: it is in the queue and the journal holds it;
 * - `dispatching`: it left the queue for its turn, so its checkpoint starts;
 * - `gate`: its checkpoint let it go, `held` where its harness holds the agent's writes instead of the message,
 *   `waited` where the message waited for the workspace to be held, `none` with no checkpoints;
 * - `assembled`: its prompt is put together, Mako's notes and context included, and goes to its driver;
 * - `delivery`: what its driver said of the send, `submitted` as it hands the prompt to its harness and the journal
 *   holds that, `accepted` once the harness says it took it.
 */
export type LiveStage = { conversation: string; request: string } & (
  | { stage: "submit" | "admitted" | "dispatching" }
  | { stage: "gate"; kind: "held" | "waited" | "none" }
  | { stage: "assembled"; chars: number }
  | { stage: "delivery"; evidence: string }
)

export const liveStages = topic<LiveStage>("mako:live-stage")

/** Each event a driver gives its conversation, as it arrives and before anything is made of it: what was decoded, and when. */
export const observedDriverEvents = topic<LiveDriverEvent>("mako:live-driver-event")

/** Each batch a flush made, as it is handed to whoever sends it on. */
export const emittedBatches = topic<LiveBatch>("mako:live-batch-emitted")
