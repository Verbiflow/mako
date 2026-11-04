import { useCallback, useEffect, useState } from "react"
import type { CloudAccessGrant, CloudAccessService, CloudAccessUse } from "@mako/host/contracts/cloud-access"
import { errorMessage, type FailureBoundary } from "@mako/host/contracts/error-message"
import { getMako } from "@/lib/bridge"
import { copyAge } from "@/lib/format"
import { refusalWords } from "@/state/github-token"
import { threadTitle } from "@/state/thread-titles"

/**
 * A project's cloud access as Settings reads and changes it, the same on the desktop and in a browser: each reaches the
 * account its own way (the Mac through its host, a browser through the gateway), and neither keeps a token. Once saved
 * a token is never read back; Settings shows the account it acts in, when it lapses and which cloud Threads were given it.
 */
export interface CloudAccessTransport {
  /** The project's grants; `repository` is its GitHub URL, as every call here takes it. */
  grants(repository: string): Promise<CloudAccessGrant[]>
  /** Checked by the cloud with the service first; `account` names the one it acts in, where it reaches several. */
  save(repository: string, service: CloudAccessService, token: string, account?: string): Promise<CloudAccessGrant>
  remove(repository: string, service: CloudAccessService): Promise<void>
  /** The latest hand-overs to cloud Threads' machines, newest first. */
  uses(repository: string): Promise<CloudAccessUse[]>
  /** The service's page for a new token, in the person's browser. */
  openUrl(url: string): void
  /** A cloud Thread's name, where this device knows it. */
  threadTitle(threadId: string): string | undefined
}

/** The desktop's: through this Mac's host, signed in to the account. */
export const desktopCloudAccess: CloudAccessTransport = {
  grants: (repository) => getMako().cloudAccess(repository),
  save: (repository, service, token, account) => getMako().cloudAccessSave(repository, service, token, account),
  remove: (repository, service) => getMako().cloudAccessRemove(repository, service),
  uses: (repository) => getMako().cloudAccessUses(repository),
  openUrl: (url) => void getMako().openUrl(url),
  threadTitle: (threadId) => threadTitle(threadId),
}

export type CloudAccessPhase =
  | { kind: "loading" }
  | { kind: "ready"; grants: CloudAccessGrant[] }
  | { kind: "failed"; message: string }

/** "Recent hand-overs", read when the person opens it. */
export type CloudAccessUsesPhase =
  | { kind: "unread" }
  | { kind: "loading" }
  | { kind: "ready"; uses: CloudAccessUse[] }
  | { kind: "failed"; message: string }

export type CloudAccessBusy = { service: CloudAccessService; doing: "saving" | "removing" }

const words = (failure: FailureBoundary) => refusalWords(errorMessage(failure))

/**
 * One project's grants as the account has them, and their changes. `errors` is each service's last refusal, in the
 * service's or the cloud's own words, until the person edits or tries again. Its user is keyed by `repository`, so
 * another project starts from nothing read.
 */
export function useCloudAccess(transport: CloudAccessTransport, repository: string) {
  const [phase, setPhase] = useState<CloudAccessPhase>({ kind: "loading" })
  const [uses, setUses] = useState<CloudAccessUsesPhase>({ kind: "unread" })
  const [busy, setBusy] = useState<CloudAccessBusy | undefined>(undefined)
  const [errors, setErrors] = useState<Partial<Record<CloudAccessService, string>>>({})
  const settle = useCallback((reading: Promise<CloudAccessGrant[]>, live: () => boolean = () => true) => {
    void reading.then((grants) => live() && setPhase({ kind: "ready", grants }), (error: Error) => live() && setPhase({ kind: "failed", message: words({ error }) }))
  }, [])
  useEffect(() => {
    let live = true
    settle(transport.grants(repository), () => live)
    return () => {
      live = false
    }
  }, [transport, repository, settle])
  /** Asked again, as Try again does after a read that failed. */
  const read = useCallback(() => {
    setPhase({ kind: "loading" })
    settle(transport.grants(repository))
  }, [transport, repository, settle])
  const readUses = useCallback(() => {
    setUses({ kind: "loading" })
    void transport.uses(repository).then((found) => setUses({ kind: "ready", uses: found }), (error: Error) => setUses({ kind: "failed", message: words({ error }) }))
  }, [transport, repository])
  const setError = useCallback((service: CloudAccessService, message: string | undefined) =>
    setErrors((current) => {
      const next = { ...current }
      if (message === undefined) delete next[service]
      else next[service] = message
      return next
    }), [])
  const save = useCallback(async (service: CloudAccessService, token: string, account?: string): Promise<boolean> => {
    setBusy({ service, doing: "saving" })
    setError(service, undefined)
    try {
      const grant = await transport.save(repository, service, token.trim(), account?.trim() || undefined)
      setPhase((current) => ({ kind: "ready", grants: [...(current.kind === "ready" ? current.grants : []).filter((each) => each.service !== service), grant] }))
      return true
    } catch (failure) {
      setError(service, words({ error: failure }))
      return false
    } finally {
      setBusy(undefined)
    }
  }, [transport, repository, setError])
  const remove = useCallback(async (service: CloudAccessService): Promise<boolean> => {
    setBusy({ service, doing: "removing" })
    setError(service, undefined)
    try {
      await transport.remove(repository, service)
      setPhase((current) => (current.kind === "ready" ? { kind: "ready", grants: current.grants.filter((each) => each.service !== service) } : current))
      return true
    } catch (failure) {
      setError(service, words({ error: failure }))
      return false
    } finally {
      setBusy(undefined)
    }
  }, [transport, repository, setError])
  const clearError = useCallback((service: CloudAccessService) => setError(service, undefined), [setError])
  return { phase, uses, busy, errors, read, readUses, save, remove, clearError }
}

/** The account a grant acts in, as Settings names it: its name, else its ID. */
export function grantAccount(grant: CloudAccessGrant): string {
  return grant.account.name ?? grant.account.id
}

/**
 * "Given to a cloud Thread 4 minutes ago", or "Not given to a cloud Thread yet". `lastGiven` is when the token was
 * handed to a cloud Thread's machine, not each command run with it, so it never says "used".
 */
export function givenWords(grant: CloudAccessGrant, now = Date.now()): string {
  return grant.lastGiven ? `Given to a cloud Thread ${copyAge(Date.parse(grant.lastGiven.at), now)}` : "Not given to a cloud Thread yet"
}

/** A use's Thread as a row names it: its title where this device knows it, else its ID. */
export function usedByName(transport: CloudAccessTransport, use: CloudAccessUse): string {
  return transport.threadTitle(use.threadId) ?? `Thread ${use.threadId}`
}
