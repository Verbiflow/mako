import type { OutdatedRestore } from "@mako/host/contracts/restore-plan"

/**
 * What the window says when a session Mako keeps the records of may be
 * newer than its harness here: a newer version wrote it, or Mako can't tell
 * which did and can't show the install here reads it. The host decides
 * (`RestorePlan`); these are only the words. Kept React-free so the rules
 * can be checked without a renderer.
 */
export interface RestoreNotice {
  /** One line: which version wrote it, or that Mako can't tell, and what's here. */
  line: string
  /** What each choice does: update to resume it, or reply to go on from its transcript. */
  detail: string
}

type Versions = Pick<OutdatedRestore, "wrote" | "upTo" | "installed" | "line" | "reader">

/** What's installed here, in words: `this Mac has 0.159.3`, or that the program isn't installed. */
function here(program: string, outdated: Versions): string {
  return outdated.installed === null ? `${program} isn't installed here` : `this Mac has ${outdated.installed}`
}

/**
 * `Codex 0.163.0 wrote this session; this Mac has 0.159.3.` A version only
 * observed running it "ran" it. Without a writer, honest about what Mako
 * can't tell: `Mako can't tell which Devin version wrote this session; this
 * Mac has 3000.10.23.`
 */
export function outdatedLine(label: string, outdated: Versions): string {
  const program = outdated.line ?? label
  // Another program's records that Mako's own build imports: say which build reads them, and that it may not.
  if (outdated.reader !== undefined) {
    const reads = `${outdated.reader}, may not read it`
    if (outdated.wrote) return `${program} ${outdated.wrote.version} wrote this session; ${reads}.`
    if (outdated.upTo) return `Mako can't tell which ${program} version wrote this session, only that it was ${outdated.upTo} or older; ${reads}.`
    return `Mako can't tell which ${program} version wrote this session; ${reads}.`
  }
  if (outdated.wrote) {
    const verb = outdated.wrote.source === "observed" ? "ran" : "wrote"
    return `${program} ${outdated.wrote.version} ${verb} this session; ${here(program, outdated)}.`
  }
  if (outdated.upTo) return `Mako can't tell which ${program} version wrote this session, only that it was ${outdated.upTo} or older; ${here(program, outdated)}.`
  return `Mako can't tell which ${program} version wrote this session; ${here(program, outdated)}.`
}

export function restoreNotice(label: string, outdated: OutdatedRestore): RestoreNotice {
  const program = outdated.line ?? label
  const reply = "or reply now to go on from its transcript"
  // Nothing names the writer or bounds it: no version here can be shown to read it, so an update can't settle it.
  if (!outdated.wrote && !outdated.upTo) return { line: outdatedLine(label, outdated), detail: "A reply goes on from its transcript in a new session." }
  const target = outdated.wrote?.version ?? outdated.upTo!
  const offer = outdated.offer
  const detail =
    outdated.reader !== undefined
      ? `It resumes here once Mako ships a build that reads ${program} ${target}; a reply now goes on from its transcript.`
      : outdated.line !== undefined
      ? `Update ${program} to ${target} or newer to resume it here, ${reply}.`
      : offer.kind === "update"
        ? `Update ${label} to resume it here, ${reply}.`
        : offer.kind === "owner" && offer.owner === "Mako"
          ? `A newer Mako brings ${label} ${target}. Update Mako to resume it here, ${reply}.`
          : offer.kind === "owner"
            ? `Update ${label} through ${offer.owner} to resume it here, ${reply}.`
            : offer.command
              ? `Update ${label} from a terminal to resume it here, ${reply}.`
              : `Update ${label} to resume it here, ${reply}.`
  return { line: outdatedLine(label, outdated), detail }
}

/** Whether Update could settle it: a version, or a bound, the install can reach, of the program Mako updates. */
export function updateResolves(outdated: OutdatedRestore): boolean {
  return Boolean((outdated.wrote || outdated.upTo) && outdated.line === undefined && outdated.reader === undefined)
}

/** What the line above a reply that went on from the transcript adds: why the harness didn't resume its own session. */
export function carriedBecause(label: string, outdated: Versions): string {
  const program = outdated.line ?? label
  if (outdated.reader !== undefined) return `${outdated.reader}, may not read what ${program} wrote`
  if (outdated.installed === null) return `${program} isn't installed here`
  if (outdated.wrote) return `${program} ${outdated.installed} here is older than ${outdated.wrote.version}`
  if (outdated.upTo) return `Mako can't tell if ${program} ${outdated.installed} here reads it`
  return `Mako can't tell which ${program} wrote it`
}

/**
 * What the window says when a Thread couldn't come back because a harness here is older than the one that wrote its
 * sessions in the cloud: which version wrote them and which is here, then how updating lets it come.
 */
export function returnNotice(label: string, outdated: OutdatedRestore): RestoreNotice {
  const wrote = outdated.wrote ? `${label} ${outdated.wrote.version} wrote its latest turns in the cloud` : outdated.upTo ? `${label} up to ${outdated.upTo} wrote its latest turns in the cloud` : `A newer ${label} wrote its latest turns in the cloud`
  const line = `${wrote}; ${outdated.installed === null ? `${label} isn't installed here` : `this Mac has ${outdated.installed}`}.`
  const offer = outdated.offer
  const detail =
    offer.kind === "update"
      ? `Update ${label} and it comes back, every session with it. Until then it goes on in the cloud.`
      : offer.kind === "owner" && offer.owner === "Mako"
        ? `A newer Mako brings a newer ${label}. Update Mako, then bring it back. Until then it goes on in the cloud.`
        : offer.kind === "owner"
          ? `Update ${label} through ${offer.owner}, then bring it back. Until then it goes on in the cloud.`
          : `Update ${label} from a terminal, then bring it back. Until then it goes on in the cloud.`
  return { line, detail }
}
