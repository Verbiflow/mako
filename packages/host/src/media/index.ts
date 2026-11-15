import type { MethodTable } from "../base/methods.js"
import type { MediaChecks, MediaConfirmation } from "../contracts/turn-media.js"
import type { TurnMedia } from "./turn-media.js"
import type { ConversationMedia } from "./conversation-media.js"

export { TurnMedia } from "./turn-media.js"
export { ConversationMedia, NOT_THIS_CONVERSATIONS, type ConversationHistory } from "./conversation-media.js"
export { registerShowTool, type ShowToolDeps } from "./show-tool.js"
export { MachineArtifacts, machineArtifactPlaces, ARTIFACTS_JOB, type ArtifactEntry, type ArtifactPlace } from "./machine-artifacts.js"

/**
 * A conversation's turn media as another device asks for it (`mako:live-turn-media`, a conversation call routed to its
 * host): only the files its records name, with the records' evidence (`ConversationMedia`).
 */
export function declareConversationMediaMethods(methods: MethodTable, media: ConversationMedia): void {
  methods.handle("mako:live-turn-media", (conversation: string, checks: MediaChecks): Promise<MediaConfirmation[]> => media.confirm(conversation, checks))
}

/** What windows ask of a turn's media: each file its records name, confirmed and kept, in one call per turn. */
export function declareMediaMethods(methods: MethodTable, media: TurnMedia): void {
  methods.handle("mako:resolve-turn-media", (checks: MediaChecks): Promise<MediaConfirmation[]> => media.confirm(checks))
}
