import type { ProviderAcpSource } from "../../electron/providers/acp-source.ts"
import type { NativeResume, ProviderLiveDriver } from "../../electron/providers/live-driver.ts"

const FIXTURE = "Injected driver fixture"
const none = { kind: "unavailable", reason: FIXTURE } as const

type Capabilities = Pick<ProviderLiveDriver, "resume" | "fork" | "steering" | "questions" | "nativeAgents" | "contextBreakdown" | "compaction" | "modeSwitching">

/** A fake driver that declares none of the live capabilities; spread it first and override what the test drives. */
export const noCapabilities: Capabilities = {
  resume: none,
  fork: none,
  steering: none,
  questions: none,
  nativeAgents: none,
  contextBreakdown: none,
  compaction: none,
  modeSwitching: { kind: "single", reason: FIXTURE },
}

/** The same for a fake ACP source, whose subagents, steering and resume carry their wire hooks. */
export const noAcpCapabilities: Pick<ProviderAcpSource, "resume" | "fork" | "steering" | "questions" | "agents" | "compaction"> = {
  resume: none,
  fork: none,
  steering: none,
  questions: none,
  agents: none,
  compaction: none,
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
