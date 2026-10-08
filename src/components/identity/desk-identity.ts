import { useCloudAccount } from "@/state/cloud-account"
import { useGitHub } from "@/state/github"
import type { CloudPerson } from "@/lib/types"

export type SignInMethod = NonNullable<CloudPerson["signedInWith"]>

/**
 * The gh CLI's login beside the account's own GitHub user. `same` and `other`
 * need both IDs; `connected` is a login with nothing to compare it with,
 * because the account has no GitHub user or hasn't said yet.
 */
export type AccountGitHub =
  | { kind: "same" | "connected" | "other"; login: string }
  | { kind: "missing"; installed: boolean }
  | { kind: "checking" }

/**
 * Whose desk this is. A Mako account outranks GitHub: it is the person, where
 * the gh CLI's login is one tool's access to repositories. Each picture stands
 * in for the other, so a person signed in to either always has a face, except
 * that a gh login known to be someone else never lends the account its face.
 */
export type DeskIdentity =
  | {
      kind: "mako"
      name: string
      email: string
      avatar?: string
      offline: boolean
      signedInWith?: SignInMethod
      github: AccountGitHub
    }
  | { kind: "github"; name: string; repo?: string; avatar?: string }
  | { kind: "none" }

export function useDeskIdentity(): DeskIdentity {
  const cloud = useCloudAccount((state) => state.account?.state)
  const status = useGitHub((state) => state.status)
  const githubAvatar = useGitHub((state) => state.userAvatar)
  const login = status?.authenticated ? status.login : undefined
  if (cloud?.status === "signed-in") {
    const { account } = cloud
    const github: AccountGitHub = !status
      ? { kind: "checking" }
      : !login
        ? { kind: "missing", installed: status.installed }
        : !account.githubId || !status.userId
          ? { kind: "connected", login }
          : { kind: account.githubId === status.userId ? "same" : "other", login }
    return {
      kind: "mako",
      name: account.name || account.email,
      email: account.email,
      avatar: account.image ?? (github.kind === "other" ? undefined : githubAvatar),
      offline: cloud.connection === "offline",
      signedInWith: account.signedInWith ?? undefined,
      github,
    }
  }
  if (login) return { kind: "github", name: login, repo: status?.repo, avatar: githubAvatar }
  return { kind: "none" }
}
