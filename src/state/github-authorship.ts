import { useCallback, useEffect, useState } from "react"
import type { CommitAuthor, GitHubAuthorship } from "@mako/host/contracts/github-authorship"
import { errorMessage } from "@mako/host/contracts/error-message"
import { MAKO_GITHUB_APP } from "@mako/host/contracts/github-person"
import { getMako } from "@/lib/bridge"

/**
 * Who cloud Threads' commits and pull requests are authored as, as Settings reads and changes it: the account's, the
 * same on the desktop (through its host) and in a browser (through the gateway).
 */
export interface GitHubAuthorships {
  read(): Promise<GitHubAuthorship>
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

/** The line under `As you` while no token is saved, pointing at "Open pull requests as me". */
export const FALLBACK_WORDS = `Pull requests are opened by ${MAKO_GITHUB_APP} until you add a token in Open pull requests as me.`

export type GitHubAuthorshipPhase =
  | { kind: "loading" }
  | { kind: "ready"; authorship: GitHubAuthorship }
  | { kind: "failed"; message: string }

const said = (message: string) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")

/**
 * The setting as the account has it, and choosing it. A choice shows at once and goes back to what the account had
 * when the save is refused; `error` is that refusal in the cloud's words.
 */
export function useGitHubAuthorship(authorships: GitHubAuthorships) {
  const [phase, setPhase] = useState<GitHubAuthorshipPhase>({ kind: "loading" })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const settle = useCallback((reading: Promise<GitHubAuthorship>, live: () => boolean = () => true) => {
    void reading.then((authorship) => live() && setPhase({ kind: "ready", authorship }), (failure: Error) => live() && setPhase({ kind: "failed", message: said(errorMessage({ error: failure })) }))
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
    const before = phase.authorship
    setPhase({ kind: "ready", authorship: { ...before, as } })
    setSaving(true)
    setError(undefined)
    try {
      setPhase({ kind: "ready", authorship: await authorships.save(as) })
    } catch (failure) {
      setPhase({ kind: "ready", authorship: before })
      setError(said(errorMessage({ error: failure })))
    } finally {
      setSaving(false)
    }
  }, [authorships, phase])
  return { phase, saving, error, choose, read }
}
