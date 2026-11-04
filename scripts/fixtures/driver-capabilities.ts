import type { ProviderAcpSource } from "@mako/host/harnesses/acp-source"
import type { NativeResume, ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import type { LayerCapabilities } from "@mako/host/contracts/mako-layer"

const FIXTURE = "Injected driver fixture"
const none = { kind: "unavailable", reason: FIXTURE } as const

type Capabilities = Pick<ProviderLiveDriver, "resume" | "fork" | "steering" | "questions" | "nativeAgents" | "nativeRouting" | "contextBreakdown" | "compaction" | "modeSwitching" | "goals" | "sideQuestions" | "review">

/** A fake driver that declares none of the live capabilities; spread it first and override what the test drives. Goals fall to Mako's loop, as for any harness without its own. */
export const noCapabilities: Capabilities = {
  resume: none,
  fork: none,
  steering: none,
  questions: none,
  nativeAgents: none,
  nativeRouting: { kind: "words", reason: FIXTURE },
  contextBreakdown: none,
  compaction: none,
  modeSwitching: { kind: "single", reason: FIXTURE },
  goals: { kind: "mako", reason: FIXTURE },
  sideQuestions: none,
  review: { kind: "mako", reason: FIXTURE },
}

/** A fake harness's adapter that takes nothing of the Mako layer natively. */
export const noLayer: LayerCapabilities = {
  instructions: { kind: "fallback", via: "prompt-note", loses: FIXTURE },
  toolServing: { kind: "fallback", via: "http-mcp", loses: FIXTURE },
  removal: { kind: "absent", reason: FIXTURE },
  interception: { kind: "absent", reason: FIXTURE },
  subagents: { kind: "absent", reason: FIXTURE },
  hooks: { kind: "absent", reason: FIXTURE },
  modelRoute: {
    "native-login": { kind: "absent", reason: FIXTURE },
    anthropic: { kind: "absent", reason: FIXTURE },
    "openai-chat": { kind: "absent", reason: FIXTURE },
    "openai-responses": { kind: "absent", reason: FIXTURE },
  },
  personSetup: "kept",
}

/** The same for a fake ACP source, whose subagents, steering and resume carry their wire hooks. */
export const noAcpCapabilities: Pick<ProviderAcpSource, "resume" | "fork" | "steering" | "questions" | "agents" | "nativeRouting" | "layer" | "compaction" | "goals" | "sideQuestions" | "review"> = {
  resume: none,
  fork: none,
  steering: none,
  questions: none,
  agents: none,
  nativeRouting: { kind: "words", reason: FIXTURE },
  layer: noLayer,
  compaction: none,
  goals: { kind: "mako", reason: FIXTURE },
  sideQuestions: none,
  review: { kind: "mako", reason: FIXTURE },
}

/**
 * A fake driver's native resume. Without hooks it reopens sessions with no
 * evidence: inspection finds none and there is no checkpoint, as a host
 * reading a store it can't see would.
 */
export function fixtureResume(hooks: Partial<Omit<Extract<NativeResume, { kind: "native" }>, "kind">> = {}): NativeResume {
  return {
    kind: "native",
    via: FIXTURE,
    wake: FIXTURE,
    checkpoint: async () => undefined,
    inspect: async () => ({ kind: "unavailable", reason: FIXTURE }),
    ...hooks,
  }
}
