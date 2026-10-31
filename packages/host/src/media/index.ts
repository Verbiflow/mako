import type { MethodTable } from "../base/methods.js"
import type { MediaChecks, MediaConfirmation } from "../contracts/turn-media.js"
import type { TurnMedia } from "./turn-media.js"

export { TurnMedia } from "./turn-media.js"
export { registerShowTool, type ShowToolDeps } from "./show-tool.js"
export { MachineArtifacts, machineArtifactPlaces, ARTIFACTS_JOB, type ArtifactEntry, type ArtifactPlace } from "./machine-artifacts.js"

/** What windows ask of a turn's media: each file its records name, confirmed and kept, in one call per turn. */
export function declareMediaMethods(methods: MethodTable, media: TurnMedia): void {
  methods.handle("mako:resolve-turn-media", (checks: MediaChecks): Promise<MediaConfirmation[]> => media.confirm(checks))
}
