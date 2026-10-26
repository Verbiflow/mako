import { useEffect } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { SignInWays } from "./sign-in-ways"
import { harnessLabel } from "@/components/rail/harness-meta"
import { accountIdentity } from "@/lib/account-identity"
import { accounts, useAccounts } from "@/state/accounts"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { signInRecovery, signInRecoveryKey, useSignInRecovery } from "@/state/sign-in-recovery"
import { shallowEqual } from "@/state/store"
import type { ComposerNotice, ComposerNoticeAction } from "@/extend/notices"
import { signInPause, type SignInPause } from "@mako/host/contracts/sign-in-hold"

/**
 * The notice above the composer while this session's work is paused because
 * its account signed out. It says what is waiting, offers the way back in
 * (Mako's own sign-in for an account it keeps, the CLI's login command for
 * the terminal's), and turns into Resume once the account is signed in
 * again or another one is chosen. Resume is the user's, once; nothing sends
 * before it. The draft, transcript and scroll are left alone.
 *
 * A notice producer (`registerNotice`).
 */
export function useSignInRecoveryNotice(): ComposerNotice | null {
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    return current ? { id: current.key, harness: current.harness, requests: current.requests } : null
  }, shallowEqual)
  const pause = live?.requests ? signInPause(live.requests) : undefined
  const id = live?.id
  const at = pause?.hold.at
  const harness = pause?.hold.harness
  const name = pause?.hold.account
  const account = useAccounts((state) => state.accounts.find((item) => item.harness === harness && item.name === name))
  const selected = useAccounts((state) => state.accounts.find((item) => item.harness === harness && item.active && !item.missing))
  const provider = useAccounts((state) => state.providers.find((item) => item.provider === harness))
  const loadedAt = useAccounts((state) => state.loadedAt)
  const signingIn = useAccounts((state) => state.signIn?.harness === harness && state.signIn?.renew === name)
  const entry = useSignInRecovery((state) => (id && at !== undefined ? state.entries[signInRecoveryKey(id, at)] : undefined))

  const paused = pause !== undefined
  useEffect(() => {
    if (paused) accounts.load()
  }, [paused])
  // A sign-in finishes elsewhere — the terminal, the browser, Settings — so
  // the notice looks again whenever Mako comes back into view or the logins change.
  useEffect(() => {
    if (id && at !== undefined) void signInRecovery.check(id, at)
  }, [id, at, loadedAt])
  useEffect(() => {
    if (!id || at === undefined) return
    const again = () => {
      if (document.visibilityState === "visible") void signInRecovery.check(id, at)
    }
    window.addEventListener("focus", again)
    document.addEventListener("visibilitychange", again)
    return () => {
      window.removeEventListener("focus", again)
      document.removeEventListener("visibilitychange", again)
    }
  }, [id, at])

  if (!live || !pause || !id || at === undefined || !harness || !name) return null
  const reading = entry?.reading ?? "checking"
  const stillOut = entry?.stillOut === true
  const label = provider?.label ?? harnessLabel(harness)
  const who = account ? accountIdentity(account) : name === "default" ? "your terminal’s login" : name
  const keptByMako = account?.source === "mako" && provider?.nativeLogin === true
  const resume = (anyway: boolean) => void signInRecovery.resume(id, at, anyway)
  const ready = reading === "ready"
  const switched = ready && selected && selected.name !== name ? accountIdentity(selected) : undefined
  const detail = describe(pause, label, ready)
  const actions: ComposerNoticeAction[] = []
  if (ready || reading === "resuming")
    actions.push({ label: reading === "resuming" ? "Resuming…" : "Resume", primary: true, disabled: reading === "resuming", onClick: () => resume(false) })
  else if (keptByMako)
    actions.push({
      label: signingIn ? "Signing in…" : "Sign in again",
      primary: true,
      disabled: signingIn,
      onClick: () => {
        void accounts.signIn(harness, name)
        window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
      },
    })
  return {
    id: `sign-in-recovery:${id}:${at}`,
    tone: ready ? "info" : "caution",
    priority: 0,
    icon: <HarnessIcon harness={harness} />,
    title: ready ? switched ? `${label} now runs as ${switched}` : `${label} is signed in again` : `${label} signed out of ${who}`,
    description: stillOut ? `Still signed out. ${detail}` : detail,
    detail: !ready && reading !== "resuming" ? (
      <SignInWays loginCommand={!keptByMako ? provider?.loginCommand : undefined} onResumeAnyway={() => resume(true)} />
    ) : undefined,
    actions,
    data: { "data-sign-in-recovery": reading },
  }
}

function describe(pause: SignInPause, label: string, ready: boolean): string {
  const waiting = pause.waiting.length
  const messages = waiting === 1 ? "1 message" : `${waiting} messages`
  const review = `Mako can’t tell whether your last message reached ${label}, so it stays below for you to review.`
  if (ready) {
    if (pause.cut?.outcome === "continue")
      return waiting ? `Resume continues the turn where it stopped, then sends ${messages}.` : "Resume continues the turn where it stopped."
    if (pause.cut?.outcome === "review") return waiting ? `Resume sends ${messages}. ${review}` : review
    return `Resume sends ${messages}.`
  }
  const cut = pause.cut?.outcome === "continue"
    ? "The turn stopped partway; its work so far is kept."
    : pause.cut?.outcome === "review" ? review : ""
  const held = waiting ? `${messages} ${waiting === 1 ? "waits" : "wait"} to send.` : ""
  return [cut, held].filter(Boolean).join(" ") || "Nothing sends until you resume."
}
