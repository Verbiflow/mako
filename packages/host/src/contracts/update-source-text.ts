import type { MissingDependencies, UpdateSource } from "./app-lifecycle.js"

/**
 * How a source checkout's reading is said, in Settings › Updates and by
 * `npm run update:local` alike, so the window and the terminal never
 * disagree about what a build will take.
 */
export interface UpdateSourceText {
  /** What is true now. */
  title: string
  /** What Build does, and why. */
  detail: string
  /** Build's label; null when there is nothing to build. */
  action: string | null
  /** The checkout and the upstream, one line: `main at 9a7a5c0c · origin/main at 079f9b31`. */
  standing: string
  /** The fetch that didn't answer, and what the reading used instead. */
  offline: string | null
}

/** A commit as Settings and the CLI name it. */
export const shortRevision = (revision: string) => revision.slice(0, 8)

const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`

/**
 * `package-lock.json lists 3 packages the checkout hasn't installed:
 * @mako/web-client, esbuild and 1 more.` Said while the build installs
 * them, and when it can't.
 */
export function missingDependenciesText({ count: total, names }: MissingDependencies): string {
  const more = total - names.length
  const listed = more > 0 ? `${names.join(", ")} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("")
  return `package-lock.json lists ${total === 1 ? "a package" : `${total} packages`} the checkout hasn't installed: ${listed}.`
}

/** `uncommitted changes in 2 files and 1 untracked file`, or null for a clean checkout. */
function localWork(changed: number, untracked: number): string | null {
  const parts = [
    changed ? `uncommitted changes in ${count(changed, "file")}` : null,
    untracked ? count(untracked, "untracked file") : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" and ") : null
}

export function updateSourceText(reading: Extract<UpdateSource, { kind: "checkout" }>): UpdateSourceText {
  const { head, branch, upstream, ahead, behind, changed, untracked, plan, target, changes, fetch } = reading
  const at = shortRevision(head)
  const name = branch ?? "HEAD"
  const standing = [`${branch ?? "detached HEAD"} at ${at}`, upstream && `${upstream.name} at ${shortRevision(upstream.commit)}`].filter(Boolean).join(" · ")
  const remote = upstream?.name.split("/")[0] ?? "the remote"
  const offline = fetch.kind === "failed" ? `Couldn't reach ${remote}: ${fetch.reason}. This compares with what was fetched from it before.` : null
  const work = localWork(changed, untracked)
  const includes = work ? ` It has ${work}; the build includes them.` : ""
  const text = (title: string, detail: string, action: string | null): UpdateSourceText => ({ title, detail, action, standing, offline })

  if (plan.kind === "current")
    return text(
      `You're already on ${shortRevision(target)}`,
      upstream ? `Your installed app was built from ${upstream.name} at its newest commit.` : `Your installed app was built from ${name} at ${at}.`,
      null
    )
  if (plan.kind === "fast-forward" && upstream && branch) {
    const fresh = changes?.from ? changes.count : behind
    return text(
      `${count(fresh, "new change")} on ${upstream.name}`,
      `Mako moves ${branch} forward to ${shortRevision(target)}, then builds and verifies the app. Your installed app and agents keep running.${untracked ? ` ${count(untracked, "untracked file")} stay as they are and go into the build.` : ""}`,
      `Update to ${branch} ${shortRevision(target)} (${count(fresh, "new change")})`
    )
  }
  const why = plan.kind === "as-is" ? plan.why : "level"
  const installed = plan.kind === "as-is" && plan.installed
  const newer = changes?.from && changes.count ? `, ${count(changes.count, "change")} newer than your app` : ""
  const asIs = installed ? ` Your app is already on ${at}, so there's nothing to build.` : ` Mako builds ${name} as it is, at ${at}.${includes}`
  const plain = installed ? null : work ? `Build ${at} with local changes` : `Build ${name} ${at}`
  switch (why) {
    case "level":
      return text("Ready to build from your checkout", `${name} is at ${upstream?.name ?? "its upstream"}'s newest commit, ${at}${newer}.${includes}`, plain)
    case "ahead":
      return text("Ready to build from your checkout", `${name} has ${count(ahead, "commit")} ${upstream?.name ?? "its upstream"} doesn't.${asIs}`, plain)
    case "changes":
      return text(
        `${count(behind, "new change")} on ${upstream?.name ?? "the upstream"}`,
        `${name} has ${work ?? "uncommitted changes"}, so Mako won't move it. Commit or discard them to take the update, or build ${at} as it is.`,
        installed ? null : `Build ${at} as it is`
      )
    case "diverged":
      return text(
        `${name} and ${upstream?.name ?? "its upstream"} have diverged`,
        `${count(ahead, "commit")} here, ${count(behind, "commit")} there. Mako won't merge them.${asIs}`,
        installed ? null : `Build ${at} as it is`
      )
    case "branch":
      return text(
        `The checkout is on ${name}`,
        `Updates come from ${upstream?.name ?? "the upstream"}${upstream?.branch ? `, which ${upstream.branch} tracks` : ""}${behind ? `, and ${name} is ${count(behind, "commit")} behind it` : ""}. Mako never switches branches.${asIs}`,
        installed ? null : `Build ${name} ${at}`
      )
    case "detached":
      return text(
        "The checkout isn't on a branch",
        `${behind && upstream ? `${upstream.name} has ${count(behind, "change")} it doesn't.` : "HEAD is detached."}${asIs}`,
        installed ? null : `Build ${at} as it is`
      )
    case "no-upstream":
      return text("Ready to build from your checkout", `There's no remote to compare with.${asIs}`, plain)
  }
}
