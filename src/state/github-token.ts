import { useCallback, useEffect, useState } from "react"
import type { GitHubTokenListing } from "@mako/host/contracts/github-person"
import { getMako } from "@/lib/bridge"
import { errorMessage } from "@mako/host/contracts/error-message"

/**
 * "Open pull requests as me" as Settings reads and changes it, the same on the desktop and in a browser: each reaches
 * the account its own way (the Mac through its host, a browser through the gateway), and neither keeps the token.
 * Once saved it's never read back; Settings shows who it belongs to and when it lapses.
 */
export interface GitHubTokens {
  read(): Promise<GitHubTokenListing | null>
  /** Checked by the cloud with GitHub first; `repository` (`owner/name`) is the one in view, to check it reaches. */
  save(token: string, repository?: string): Promise<GitHubTokenListing>
  remove(): Promise<void>
  /** GitHub's page for a new token, in the person's browser. */
  openUrl(url: string): void
}

/** The desktop's: through this Mac's host, signed in to the account. */
export const desktopGitHubTokens: GitHubTokens = {
  read: () => getMako().githubToken(),
  save: (token, repository) => getMako().githubTokenSave(token, repository),
  remove: () => getMako().githubTokenRemove(),
  openUrl: (url) => void getMako().openUrl(url),
}

export type GitHubTokenPhase =
  | { kind: "loading" }
  | { kind: "ready"; listing: GitHubTokenListing | null }
  | { kind: "failed"; message: string }

/** A refusal in the cloud's or GitHub's own words, without the bridge's wrapping. */
const said = (message: string) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")

/** The setting as the account has it, and its two changes; `error` is the last change's refusal, in GitHub's or the cloud's words. */
export function useGitHubToken(tokens: GitHubTokens) {
  const [phase, setPhase] = useState<GitHubTokenPhase>({ kind: "loading" })
  const [busy, setBusy] = useState<"saving" | "removing" | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const settle = useCallback((reading: Promise<GitHubTokenListing | null>, live: () => boolean = () => true) => {
    void reading.then((listing) => live() && setPhase({ kind: "ready", listing }), (failure: Error) => live() && setPhase({ kind: "failed", message: said(errorMessage({ error: failure })) }))
  }, [])
  useEffect(() => {
    let live = true
    settle(tokens.read(), () => live)
    return () => {
      live = false
    }
  }, [tokens, settle])
  /** Asked again, as Try again does after a read that failed. */
  const read = useCallback(() => {
    setPhase({ kind: "loading" })
    settle(tokens.read())
  }, [tokens, settle])
  const save = useCallback(async (token: string, repository?: string): Promise<boolean> => {
    setBusy("saving")
    setError(undefined)
    try {
      setPhase({ kind: "ready", listing: await tokens.save(token.trim(), repository) })
      return true
    } catch (failure) {
      setError(said(errorMessage({ error: failure })))
      return false
    } finally {
      setBusy(undefined)
    }
  }, [tokens])
  const remove = useCallback(async (): Promise<boolean> => {
    setBusy("removing")
    setError(undefined)
    try {
      await tokens.remove()
      setPhase({ kind: "ready", listing: null })
      return true
    } catch (failure) {
      setError(said(errorMessage({ error: failure })))
      return false
    } finally {
      setBusy(undefined)
    }
  }, [tokens])
  return { phase, busy, error, save, remove, read, clearError: () => setError(undefined) }
}

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })

/** When a token lapses, as Settings says it, and whether it has. */
export type ExpiryWords = { text: string; lapsed: boolean }

/** When the token lapses, in words: "Expires Nov 29, 2026", "Expired Oct 1, 2026", or that it doesn't. */
export function expiryWords(expiresAt: string | null, now = Date.now()): ExpiryWords {
  if (!expiresAt) return { text: "No expiry date", lapsed: false }
  const at = Date.parse(expiresAt)
  return at <= now ? { text: `Expired ${day.format(at)}`, lapsed: true } : { text: `Expires ${day.format(at)}`, lapsed: false }
}
