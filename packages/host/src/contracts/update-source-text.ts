import type { BuildIdentity, MissingDependencies, UncommittedFile, UpdateBuildFrom, UpdateSource } from "./app-lifecycle.js"

/**
 * How a source checkout's reading is said, in Settings › Updates and by
 * `npm run update:local` alike, so the window and the terminal never
 * disagree about what a build will take.
 */
export interface UpdateSourceText {
  /** What is true now. */
  title: string
  /** What Build does, and why: where it builds from, at which commit, and what it leaves out. */
  detail: string
  /** Build's label; null when nothing is recommended. */
  action: string | null
  /** Where Build builds from. */
  from: UpdateBuildFrom | null
  /** The other build on offer, beside Build; null when there's none. */
  alternative: { label: string; from: UpdateBuildFrom } | null
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

/** `41 uncommitted changes`: a build's uncommitted files, counted the same way before it's built and once it's installed. */
export const uncommittedCount = (n: number) => count(n, "uncommitted change")

/**
 * The revision a build was made from and what it took beyond it:
 * `9a7a5c0c with 41 uncommitted changes`. A build from an updater that
 * didn't name its files says only that it had some.
 */
export function buildRevisionText(build: Pick<BuildIdentity, "revision" | "dirty" | "uncommitted">): string {
  const at = build.revision ? shortRevision(build.revision) : "an unrecorded revision"
  const taken = builtWith(build)
  return taken ? `${at} ${taken}` : at
}

/** `with 41 uncommitted changes`, or null for a build that took none. */
export function builtWith(build: Pick<BuildIdentity, "dirty" | "uncommitted">): string | null {
  if (!build.dirty) return null
  return `with ${build.uncommitted?.count ? uncommittedCount(build.uncommitted.count) : "uncommitted changes"}`
}

/** What happened to an uncommitted file, in a word or two: `Edited`, `Renamed from src/old.ts`. */
export function uncommittedChangeText(file: UncommittedFile): string {
  switch (file.change) {
    case "edited": return "Edited"
    case "added": return "Added"
    case "deleted": return "Deleted"
    case "renamed": return `Renamed from ${file.from ?? "another path"}`
    case "untracked": return "Untracked"
    case "conflicted": return "Conflicted"
  }
}

/** `uncommitted changes in 2 files and 1 untracked file`, or null for a clean checkout. */
function localWork(changed: number, untracked: number): string | null {
  const parts = [
    changed ? `uncommitted changes in ${count(changed, "file")}` : null,
    untracked ? count(untracked, "untracked file") : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" and ") : null
}

/** How the checkout stands against the upstream, as a clause: `main is 35 commits behind origin/main`. */
function standingClause(reading: Extract<UpdateSource, { kind: "checkout" }>): string | null {
  const { branch, upstream, ahead, behind, plan } = reading
  const name = branch ?? "HEAD"
  const there = upstream?.name ?? "the upstream"
  switch (plan.checkout.standing) {
    case "level": return null
    case "behind": return `${name} is ${count(behind, "commit")} behind ${there}`
    case "ahead": return `${name} has ${count(ahead, "commit")} ${there} doesn't`
    case "diverged": return `${name} has ${count(ahead, "commit")} ${there} doesn't and is ${count(behind, "commit")} behind it`
    case "branch": return `The checkout is on ${name}${upstream?.branch ? `, not ${upstream.branch}` : ""}`
    case "detached": return "The checkout's HEAD isn't on a branch"
    case "no-upstream": return null
  }
}

/** Who changed the uncommitted files, as the journal names them: `from “Fix the runner” and you`. */
function writersOf(reading: Extract<UpdateSource, { kind: "checkout" }>): string | null {
  const names = [...new Set(reading.uncommitted.files.flatMap((file) => file.by ?? []))]
  if (!names.length) return null
  const quoted = names.map((name) => name === "you" ? name : `“${name}”`)
  const listed = quoted.length > 3 ? `${quoted.slice(0, 3).join(", ")} and ${quoted.length - 3} more` : quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0]
  return `changed by ${listed}`
}

export function updateSourceText(reading: Extract<UpdateSource, { kind: "checkout" }>): UpdateSourceText {
  const { head, branch, upstream, changed, untracked, plan, changes, fetch } = reading
  const at = shortRevision(head)
  const name = branch ?? "HEAD"
  const standing = [`${branch ?? "detached HEAD"} at ${at}`, upstream && `${upstream.name} at ${shortRevision(upstream.commit)}`].filter(Boolean).join(" · ")
  const remote = upstream?.name.split("/")[0] ?? "the remote"
  const offline = fetch.kind === "failed" ? `Couldn't reach ${remote}: ${fetch.reason}. This compares with what was fetched from it before.` : null
  const work = localWork(changed, untracked)
  const who = writersOf(reading)
  const text = (title: string, detail: string, from: UpdateBuildFrom | null, action: string | null, alternative: UpdateSourceText["alternative"]): UpdateSourceText => ({ title, detail, action, from, alternative, standing, offline })
  const asIs = work ? `Build ${name} ${at} with ${uncommittedCount(changed + untracked)}` : `Build ${name} ${at} as it is`
  const checkoutChoice = plan.checkout.installed ? null : { label: asIs, from: "checkout" as const }
  const clause = upstream ? standingClause(reading) : null

  if (plan.recommended === "upstream" && upstream) {
    const target = shortRevision(upstream.commit)
    const fresh = changes?.from ? changes.count : reading.behind
    const left = [clause, work && `${clause ? "it has" : "Your checkout has"} ${work}${who ? `, ${who},` : ""} that this build leaves out`].filter(Boolean)
    return text(
      fresh ? `${count(fresh, "new change")} on ${upstream.name}` : `Ready to build ${upstream.name}`,
      `Mako builds ${upstream.name} at ${target} in a clean copy of its own and leaves your checkout exactly as it is.${left.length ? ` ${left.join(", and ")}.` : ""}`,
      "upstream",
      fresh ? `Update to ${upstream.name} ${target} (${count(fresh, "new change")})` : `Build ${upstream.name} ${target}`,
      checkoutChoice
    )
  }
  const upstreamChoice = upstream && plan.upstream && !plan.upstream.installed ? { label: `Build ${upstream.name} ${shortRevision(upstream.commit)} instead`, from: "upstream" as const } : null
  const includes = work ? ` It has ${work}${who ? `, ${who}` : ""}; the build includes them.` : ""
  if (plan.recommended === "checkout") {
    const why = clause ? `${clause}. ` : !upstream ? "There's no remote to compare with. " : ""
    return text("Ready to build from your checkout", `${why}Mako builds ${name} as it is, at ${at}.${includes}`, "checkout", work ? `Build ${at} with local changes` : `Build ${name} ${at}`, upstreamChoice)
  }
  // Nothing recommended: the app already runs the upstream, or the checkout as it is.
  const runs = plan.upstream?.installed && upstream ? shortRevision(upstream.commit) : at
  const extra = checkoutChoice && (work || reading.ahead) ? ` ${[clause, work && `${clause ? "it has" : "Your checkout has"} ${work}${who ? `, ${who}` : ""}`].filter(Boolean).join(", and ")}; build it as it is to try ${work ? "them" : "it"}.` : ""
  return text(
    `You're already on ${runs}`,
    `${upstream && plan.upstream?.installed ? `Your installed app was built from ${upstream.name} at its newest commit.` : `Your installed app was built from ${name} at ${at}.`}${extra}`,
    null,
    null,
    extra ? checkoutChoice : null
  )
}

