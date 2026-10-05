import { getMako } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"
import type { SignInReadiness } from "../../electron/contracts/live-conversations"

export type SignInReading = SignInReadiness | "checking" | "resuming"

/** What the card knows about one pause, keyed by conversation and the pause's own moment. */
export interface SignInRecoveryEntry {
  reading: SignInReading
  /** Resume found the account still signed out. */
  stillOut?: boolean
}

interface SignInRecoveryState {
  entries: Record<string, SignInRecoveryEntry>
}

export const signInRecoveryStore = createStore<SignInRecoveryState>({ entries: {} })
export const useSignInRecovery = createHook(signInRecoveryStore)

export function signInRecoveryKey(id: string, at: number): string {
  return `${id}:${at}`
}

const checks = new Map<string, number>()

function patch(key: string, entry: SignInRecoveryEntry): void {
  signInRecoveryStore.set((state) => ({ entries: { ...state.entries, [key]: entry } }))
}

function reading(key: string): SignInReading {
  return signInRecoveryStore.get().entries[key]?.reading ?? "checking"
}

/**
 * Readiness and Resume for work paused on a sign-out. The host decides both;
 * this keeps what it last said, so a stale answer never overwrites a newer
 * one and a check never interrupts a Resume in flight.
 */
export const signInRecovery = {
  async check(id: string, at: number): Promise<void> {
    const key = signInRecoveryKey(id, at)
    const attempt = (checks.get(key) ?? 0) + 1
    checks.set(key, attempt)
    let next: SignInReadiness | null
    try {
      next = await getMako().liveSignInReadiness(id)
    } catch {
      next = "signed-out"
    }
    const current = signInRecoveryStore.get().entries[key]
    if (checks.get(key) !== attempt || !next || current?.reading === "resuming") return
    patch(key, { ...current, reading: next })
  },

  async resume(id: string, at: number, anyway: boolean): Promise<void> {
    const key = signInRecoveryKey(id, at)
    if (reading(key) === "resuming") return
    checks.set(key, (checks.get(key) ?? 0) + 1)
    patch(key, { reading: "resuming" })
    let stillOut: boolean
    try {
      stillOut = (await getMako().liveSignInResume(id, anyway)) === "signed-out"
    } catch {
      stillOut = true
    }
    patch(key, stillOut ? { reading: "signed-out", stillOut } : { reading: "resuming" })
  },
}
