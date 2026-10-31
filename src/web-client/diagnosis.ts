import { copyAge } from "@/lib/format"

/**
 * Why something can't be reached from this browser, said as the chain it goes through: this phone, Mako Cloud, the Mac
 * (or the cloud Thread's machine) and the harness on it. Each hop is `ok`, `failed`, or `unknown` (not reached, or not
 * checked yet): what nobody has heard is never painted as off. One headline names the first hop that failed, in the
 * person's words, with what it may be, most likely first, and the facts a bug report needs, never a secret.
 */

export type HopState = "ok" | "failed" | "unknown"

export interface Hop {
  id: "phone" | "cloud" | "mac" | "machine" | "harness"
  label: string
  state: HopState
}

export interface Diagnosis {
  /** What's wrong, in a sentence: "Studio is asleep or offline". */
  headline: string
  /** What goes with it on its own line: when it was last seen, the harness's own reason. */
  detail?: string
  hops: Hop[]
  /** What it may be, most likely first. */
  causes: string[]
  /** For Copy diagnostics: correlation IDs, versions and times, by name. */
  facts: Array<[string, string]>
  /** Which hop the headline is about. */
  at: Hop["id"]
}

/** What this browser knows of each hop as it stands. */
export interface ReachInput {
  now: number
  /** What this end is called: "This phone", "This tablet", "This browser" on a laptop. */
  here?: string
  /** The browser says it has a network (`navigator.onLine`). */
  online: boolean
  /** Mako Cloud: its last answer here worked, failed, or none came yet. */
  cloud: HopState
  /** The Mac it runs on, when it runs on one. */
  mac?: {
    name: string
    /** When the cloud last heard from it, while it's quiet (`device-quiet`). */
    quietSince?: string
    /** Whether a call to it went through, failed as not connected, or hasn't been tried. */
    link: HopState
    /** It never connected to the account (enrolled, never heard from). */
    never?: boolean
    version?: string
  }
  /** A cloud Thread's machine, when it runs in the cloud. */
  machine?: { state: HopState; reason?: string }
  /** The harness the Thread runs, as its owner last said it. */
  harness?: { name: string; state: HopState; reason?: string }
  /** The last failure heard, for its correlation ID and time. */
  failure?: { message: string; at: number; correlationId?: string; outcome?: string }
  /** Read from the copy its Mac keeps in the account, that Mac being off: when the Mac wrote it, and how it was read here. */
  copy?: { at: number; read?: string }
  /** Anything else worth quoting: the build, this browser's device, the list's number. */
  facts?: Array<[string, string]>
}

/** "5 minutes ago", never in the future: a clock ahead of this one can't make a Mac seen later than now. */
export function lastSeen(since: string, now: number): string {
  const at = Date.parse(since)
  return copyAge(Number.isFinite(at) ? Math.min(at, now) : now, now)
}

/**
 * The first hop that failed, said as a headline, and every hop before it as reached and after it as unknown. Nothing
 * failed: undefined.
 */
export function diagnose(input: ReachInput): Diagnosis | undefined {
  const host = input.mac?.name
  const hops: Hop[] = [{ id: "phone", label: input.here ?? "This phone", state: "unknown" }, { id: "cloud", label: "Mako Cloud", state: "unknown" }]
  if (input.mac) hops.push({ id: "mac", label: input.mac.name, state: "unknown" })
  if (input.machine) hops.push({ id: "machine", label: "Cloud machine", state: "unknown" })
  if (input.harness) hops.push({ id: "harness", label: input.harness.name, state: "unknown" })
  const found = locate(input)
  if (!found) return undefined
  const failedAt = hops.findIndex((hop) => hop.id === found.at)
  // Past the hop that failed nothing was reached: what was heard of it before is history, not its state now.
  for (const [index, hop] of hops.entries()) hop.state = index < failedAt ? "ok" : index === failedAt ? "failed" : "unknown"
  const facts: Array<[string, string]> = []
  if (input.failure) {
    facts.push(["Last failure", input.failure.message], ["At", new Date(input.failure.at).toISOString()])
    if (input.failure.outcome) facts.push(["Outcome", input.failure.outcome])
    if (input.failure.correlationId) facts.push(["Correlation ID", input.failure.correlationId])
  }
  if (input.mac?.quietSince) facts.push([`${host} last heard`, input.mac.quietSince])
  if (input.mac?.version) facts.push([`Mako on ${host}`, input.mac.version])
  if (input.copy) facts.push(["Copy written", new Date(input.copy.at).toISOString()])
  if (input.copy?.read) facts.push(["Copy read", input.copy.read])
  facts.push(...(input.facts ?? []))
  // Its Mac off, what's on screen is that Mac's copy: said beside when it was last seen, with how old the copy is.
  const written = input.copy && found.at === "mac" ? copyAge(input.copy.at, input.now) : undefined
  const detail = !written ? found.detail : found.detail ? `${found.detail} · reading its copy from ${written}` : `Reading its copy from ${written}`
  return { ...found, ...(detail && { detail }), hops, facts }
}

type Found = Pick<Diagnosis, "headline" | "detail" | "causes" | "at">

function locate(input: ReachInput): Found | undefined {
  if (!input.online)
    return { at: "phone", headline: `${input.here ?? "This phone"} is offline`, causes: ["Wi-Fi or mobile data may be off, or in a dead spot.", "Mako reconnects on its own once it has a network."] }
  if (input.cloud === "failed")
    return {
      at: "cloud",
      headline: "Mako Cloud isn't answering",
      ...(input.failure && { detail: input.failure.message }),
      causes: ["It may be a short outage; Mako keeps trying.", `A VPN, firewall or content blocker on ${(input.here ?? "This phone").replace(/^This/, "this")} may be blocking it.`],
    }
  const mac = input.mac
  if (mac) {
    const name = mac.name
    if (mac.never)
      return { at: "mac", headline: `${name} hasn't connected yet`, causes: [`Mako may not be open on ${name}.`, `${name} may be signed in to another account.`] }
    if (mac.quietSince)
      return {
        at: "mac",
        headline: `${name} is asleep or offline`,
        detail: `Last seen ${lastSeen(mac.quietSince, input.now)}`,
        causes: ["It may be asleep, or its lid closed.", `Mako may be closed on ${name}.`, `${name} may have lost its network.`],
      }
    if (mac.link === "failed")
      return {
        at: "mac",
        headline: `Mako Cloud answers, but ${name}'s Mako isn't connected`,
        causes: [`Mako may be closed or restarting on ${name}.`, `${name} may have just gone to sleep.`, `${name} may have lost its network.`],
      }
  }
  if (input.machine?.state === "failed")
    return {
      at: "machine",
      headline: "This Thread's cloud machine didn't start",
      ...(input.machine.reason && { detail: input.machine.reason }),
      causes: ["The cloud may be busy; it tries again when you send.", "Its repository may no longer be reachable from the cloud."],
    }
  const harness = input.harness
  if (harness?.state === "failed") {
    const where = mac ? ` on ${mac.name}` : input.machine ? " in the cloud" : ""
    return {
      at: "harness",
      headline: `${harness.name}${where} didn't start`,
      ...(harness.reason && { detail: harness.reason }),
      causes: [`${harness.name} may not be signed in${where}.`, `${harness.name} may need an update${where}.`],
    }
  }
  return undefined
}

const MARK = { ok: "ok", failed: "FAILED", unknown: "not checked" } satisfies Record<HopState, string>

/** Diagnostics as plain text, for a bug report: the headline, each hop, the causes and the facts. No secrets. */
export function diagnosisText(diagnosis: Diagnosis): string {
  return [
    diagnosis.headline + (diagnosis.detail ? ` · ${diagnosis.detail}` : ""),
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${MARK[hop.state]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
  ].join("\n")
}
