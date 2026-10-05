import { useEffect, useState } from "react"
import { CheckIcon, CopyIcon, PlayIcon } from "lucide-react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Action } from "@/components/ui/kit"
import { harnessLabel } from "@/components/rail/harness-meta"
import { accountIdentity } from "@/lib/account-identity"
import { accounts, useAccounts } from "@/state/accounts"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { signInRecovery, signInRecoveryKey, useSignInRecovery } from "@/state/sign-in-recovery"
import { shallowEqual } from "@/state/store"
import { cn } from "@/lib/utils"
import { signInPause, type SignInPause } from "../../../electron/contracts/sign-in-hold"

/**
 * The card above the composer while this session's work is paused because
 * its account signed out. It says what is waiting, offers the way back in
 * (Mako's own sign-in for an account it keeps, the CLI's login command for
 * the terminal's), and turns into Resume once the account is signed in
 * again or another one is chosen. Resume is the user's, once; nothing sends
 * before it. The draft, transcript and scroll are left alone.
 *
 * Registered on `composer.above`.
 */
export function SignInRecovery() {
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    return current ? { id: current.key, harness: current.harness, requests: current.requests } : null
  }, shallowEqual)
  const pause = live?.requests ? signInPause(live.requests) : undefined
  if (!live || !pause) return null
  return <SignInCard key={`${live.id}:${pause.hold.at}`} id={live.id} pause={pause} />
}

function SignInCard({ id, pause }: { id: string; pause: SignInPause }) {
  const { harness, account: name } = pause.hold
  const account = useAccounts((state) => state.accounts.find((item) => item.harness === harness && item.name === name))
  const selected = useAccounts((state) => state.accounts.find((item) => item.harness === harness && item.active && !item.missing))
  const provider = useAccounts((state) => state.providers.find((item) => item.provider === harness))
  const loadedAt = useAccounts((state) => state.loadedAt)
  const signingIn = useAccounts((state) => state.signIn?.harness === harness && state.signIn.renew === name)
  const at = pause.hold.at
  const entry = useSignInRecovery((state) => state.entries[signInRecoveryKey(id, at)])
  const reading = entry?.reading ?? "checking"
  const stillOut = entry?.stillOut === true
  const [copied, setCopied] = useState(false)
  const label = provider?.label ?? harnessLabel(harness)
  const who = account ? accountIdentity(account) : name === "default" ? "your terminal’s login" : name
  const keptByMako = account?.source === "mako" && provider?.nativeLogin === true

  useEffect(() => {
    accounts.load()
  }, [])
  // A sign-in finishes elsewhere — the terminal, the browser, Settings — so
  // the card looks again whenever Mako comes back into view or the logins change.
  useEffect(() => {
    void signInRecovery.check(id, at)
  }, [id, at, loadedAt])
  useEffect(() => {
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

  const resume = (anyway: boolean) => void signInRecovery.resume(id, at, anyway)

  async function copyCommand() {
    if (!provider) return
    await navigator.clipboard.writeText(provider.loginCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const ready = reading === "ready"
  const switched = ready && selected && selected.name !== name ? accountIdentity(selected) : undefined
  const title = ready
    ? switched ? `${label} now runs as ${switched}` : `${label} is signed in again`
    : `${label} signed out of ${who}`
  const detail = describe(pause, label, ready)

  return (
    <section
      aria-label={`${label} sign-in`}
      data-sign-in-recovery={reading}
      className="mb-1.5 rounded-md bg-raised px-2.5 py-2 text-ui"
    >
      <div className="flex items-center gap-2">
        <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
        <p role="status" className={cn("min-w-0 flex-1 truncate font-medium", ready ? "text-foreground" : "text-caution")} title={title}>
          {title}
        </p>
        {ready || reading === "resuming" ? (
          <Action tone="solid" size="xs" disabled={reading === "resuming"} onClick={() => resume(false)}>
            <PlayIcon />
            {reading === "resuming" ? "Resuming…" : "Resume"}
          </Action>
        ) : keptByMako ? (
          <Action
            tone="solid"
            size="xs"
            disabled={signingIn}
            onClick={() => {
              void accounts.signIn(harness, name)
              window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
            }}
          >
            {signingIn ? "Signing in…" : "Sign in again"}
          </Action>
        ) : null}
      </div>
      <p className="mt-1 pl-5.5 text-label text-faint">{stillOut ? `Still signed out. ${detail}` : detail}</p>
      {!ready && reading !== "resuming" ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-5.5 text-label">
          {!keptByMako && provider ? (
            <>
              <span className="text-faint">Run</span>
              <code className="rounded bg-fill-hover px-1 py-0.5 font-mono text-foreground">{provider.loginCommand}</code>
              <span className="text-faint">in a terminal, then come back here.</span>
              <Action size="xs" aria-label="Copy the login command" onClick={() => void copyCommand()}>
                {copied ? <CheckIcon className="text-positive" /> : <CopyIcon />}
                {copied ? "Copied" : "Copy"}
              </Action>
            </>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            <Action size="xs" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))}>
              Use another account
            </Action>
            <Action size="xs" title="Try now, without waiting to see a new sign-in" onClick={() => resume(true)}>
              Resume anyway
            </Action>
          </span>
        </div>
      ) : null}
    </section>
  )
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
