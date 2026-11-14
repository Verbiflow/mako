import { useCallback, useEffect, useState } from "react"
import type { CommitAuthor, GitHubAuthorship } from "@mako/host/contracts/github-authorship"
import { MAKO_GITHUB_APP } from "@mako/host/contracts/github-person"
import { getMako } from "@/lib/bridge"

/**
 * Who cloud Threads' commits and pull requests are authored as, as Settings reads and changes it: the account's, the
 * same on the desktop (through its host) and in a browser (through the gateway). `read` is null from a cloud that doesn't
 * keep it yet.
 */
export interface GitHubAuthorships {
  read(): Promise<GitHubAuthorship | null>
  save(as: CommitAuthor): Promise<GitHubAuthorship>
}

/** The desktop's: through this Mac's host, signed in to the account. */
export const desktopGitHubAuthorships: GitHubAuthorships = {
  read: () => getMako().githubAuthorship(),
  save: (as) => getMako().githubAuthorshipSave(as),
}

/** Words under each choice, as every device says them; `hasToken` is undefined until the token's state is known. */
export function authorshipWords(as: CommitAuthor, hasToken: boolean | undefined): string {
  if (as === "mako") return "Commits name Mako's bot, with you as co-author."
  return hasToken ? "Commits name you, and pull requests open with your GitHub token." : "Commits name you."
}

/** What a saved token does under `As Mako`, on the row that keeps it. */
export const TOKEN_KEPT_WORDS = "Your token is kept, but not used while commits and pull requests are as Mako."

/** The line under `As you` while no token is saved, pointing at "Open pull requests as me". */
export const FALLBACK_WORDS = `Pull requests are opened by ${MAKO_GITHUB_APP} until you add a token in Open pull requests as me.`

/** Where the cloud doesn't keep the setting yet: a release's gap, nothing the person did or can fix. */
export const AUTHORSHIP_UNAVAILABLE = "This choice isn't on Mako Cloud yet. It will appear here after Mako Cloud's next update, and there's nothing you need to do."
/** Every other failure to read it. */
export const AUTHORSHIP_UNREAD = "Mako couldn't read this from Mako Cloud. Check your connection, then try again."
/** A save with no answer: it may have landed, so this promises only what was read back after it. */
export const AUTHORSHIP_UNCONFIRMED = "Mako couldn't confirm that choice, so this shows what Mako Cloud has now. Check your connection, then choose again if you need to."

export type GitHubAuthorshipPhase =
  | { kind: "loading" }
  | { kind: "ready"; authorship: GitHubAuthorship }
  | { kind: "unavailable" }
  | { kind: "failed" }

/** Whether there's a choice to show: while it's read, or read. */
export const authorshipChoosable = (phase: GitHubAuthorshipPhase) => phase.kind === "ready" || phase.kind === "loading"

/**
 * The setting as the account has it, and choosing it. A choice shows at once. A save with no answer may still have
 * landed, so it's read back rather than undone: `error` says it's unconfirmed, and if the read fails too nothing is said
 * of who commits name.
 */
export function useGitHubAuthorship(authorships: GitHubAuthorships) {
  const [phase, setPhase] = useState<GitHubAuthorshipPhase>({ kind: "loading" })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const settle = useCallback((reading: Promise<GitHubAuthorship | null>, live: () => boolean = () => true) => {
    void reading.then((authorship) => live() && setPhase(authorship ? { kind: "ready", authorship } : { kind: "unavailable" }), () => live() && setPhase({ kind: "failed" }))
  }, [])
  useEffect(() => {
    let live = true
    settle(authorships.read(), () => live)
    return () => {
      live = false
    }
  }, [authorships, settle])
  const read = useCallback(() => {
    setPhase({ kind: "loading" })
    settle(authorships.read())
  }, [authorships, settle])
  const choose = useCallback(async (as: CommitAuthor): Promise<void> => {
    if (phase.kind !== "ready" || phase.authorship.as === as) return
    setPhase({ kind: "ready", authorship: { ...phase.authorship, as } })
    setSaving(true)
    setError(undefined)
    try {
      setPhase({ kind: "ready", authorship: await authorships.save(as) })
    } catch {
      setPhase({ kind: "loading" })
      setError(AUTHORSHIP_UNCONFIRMED)
      try {
        const now = await authorships.read()
        setPhase(now ? { kind: "ready", authorship: now } : { kind: "unavailable" })
      } catch {
        setPhase({ kind: "failed" })
        setError(undefined)
      }
    } finally {
      setSaving(false)
    }
  }, [authorships, phase])
  return { phase, saving, error, choose, read }
}
