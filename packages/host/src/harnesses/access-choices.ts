import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { ACCESS_TIER_NAMES, accessTierOfModeId } from "../contracts/access.js"
import type { AccessChoice, AccessChoices } from "../contracts/access-choices.js"
import type { LiveSessionMode } from "../contracts/providers-acp.js"
import type { MethodTable } from "../base/methods.js"

/**
 * A choice as it's kept or said, its tier read leniently: one a newer Mako chose, on a tier this build doesn't know,
 * still names its mode. A mangled one is no choice.
 */
const SaidChoiceSchema = z.object({ mode: z.string().min(1).max(64), access: z.string().optional() })
type SaidChoice = z.infer<typeof SaidChoiceSchema>
const SaidChoicesSchema = z.record(z.string(), SaidChoiceSchema.optional().catch(undefined))
type SaidChoices = Readonly<Record<string, SaidChoice | undefined>>

/** One account's choices at a revision, which each change raises: an older one is never taken over a newer. */
export interface AccountAccessChoices {
  /** The account's ID: another account's revisions are its own. */
  account: string
  choices: SaidChoices
  revision: number
}

/** The account's end of the choices (`PATCH`/`GET /v1/access`); undefined from a cloud that doesn't keep them yet. */
export interface AccessChoicesAccount {
  read(): Promise<AccountAccessChoices | undefined>
  /** Makes `choices`, or with `fill` only those the account has none for; answers all of them after. */
  write(choices: AccessChoices, fill: boolean): Promise<AccountAccessChoices | undefined>
}

export interface AccessChoiceDeps {
  /** `<user root>/access-choices.json`: every host of this user (the app, its profiles) reads the same. */
  file: string
  /** The harness's ladder, as its live driver declares it; undefined for a harness this host doesn't drive. */
  modes(harness: string): readonly LiveSessionMode[] | undefined
  /** The signed-in account's end, or undefined while signed out, or on a host that acts for no person (a cloud machine). */
  account(): Promise<AccessChoicesAccount | undefined>
  /** The choices changed: every window hears them. */
  announce(choices: AccessChoices): void
  log?(message: string, fields?: Record<string, string | number | boolean>): void
}

const StoredSchema = z.object({
  version: z.literal(1),
  /** As the account last said them, and at which of its revisions; each made here since is laid over them. */
  choices: SaidChoicesSchema.default({}),
  revision: z.number().int().nonnegative().optional(),
  account: z.string().optional(),
  /** Made here and not yet taken by the account: sent at the next sync, each replacing the account's. */
  unsent: SaidChoicesSchema.default({}),
  /** A window's own copy from before (`providerModes`): the account takes each only where it has no choice yet. */
  offered: SaidChoicesSchema.default({}),
})
type Stored = { choices: AccessChoices; account?: string; revision?: number; unsent: AccessChoices; offered: AccessChoices }

/** Each choice as this build reads it: a tier it doesn't know is left out, the mode kept. */
function readable(said: SaidChoices): AccessChoices {
  const choices: AccessChoices = {}
  for (const [harness, choice] of Object.entries(said)) {
    if (!choice) continue
    const access = ACCESS_TIER_NAMES.find((tier) => tier === choice.access)
    choices[harness] = access ? { mode: choice.mode, access } : { mode: choice.mode }
  }
  return choices
}

const same = (left: AccessChoice | undefined, right: AccessChoice | undefined) => left?.mode === right?.mode && left?.access === right?.access

/**
 * The person's access choice per harness, as this host knows them (`contracts/access-choices.ts`). The account owns
 * them: each choice made here goes to it at once, the account's answer and its `access-chosen` events replace what's
 * kept, and what's kept is only for a start while the account can't be reached. A choice the account didn't take yet
 * (offline, signed out) is kept as unsent, laid over what the account says and sent again at the next sync. A host that
 * isn't signed in keeps them alone. The file is read again when another host of this user wrote it.
 */
export class AccessChoiceStore {
  readonly #deps: AccessChoiceDeps
  #stored: Stored = { choices: {}, unsent: {}, offered: {} }
  #readAt = -1
  #syncing: Promise<void> = Promise.resolve()

  constructor(deps: AccessChoiceDeps) {
    this.#deps = deps
  }

  /** Every choice in effect: the account's as last heard, with those made here it hasn't taken yet. */
  current(): AccessChoices {
    const { choices, unsent, offered } = this.#read()
    const merged: AccessChoices = { ...choices }
    for (const [harness, choice] of Object.entries(offered)) merged[harness] ??= choice
    return { ...merged, ...unsent }
  }

  /** The mode a new session of `harness` starts in when its start names none: the person's, while the harness offers it. */
  mode(harness: string): string | undefined {
    const mode = this.current()[harness]?.mode
    return mode && this.#deps.modes(harness)?.some((offered) => offered.id === mode) ? mode : undefined
  }

  /** The person chose `mode` for `harness`: in effect here at once, and the account's once it takes it. */
  async choose(harness: string, mode: string): Promise<AccessChoices> {
    const modes = this.#deps.modes(harness)
    if (modes && !modes.some((offered) => offered.id === mode)) throw new Error(`${harness} offers no mode ${mode}`)
    const stored = this.#read()
    const before = this.current()
    const choice = this.#choice(harness, mode)
    const unsent = { ...stored.unsent }
    // What the account said last already is the choice: nothing to send, and an older choice not sent goes.
    if (same(stored.choices[harness], choice)) delete unsent[harness]
    else unsent[harness] = choice
    if (!same(stored.unsent[harness], unsent[harness])) this.#write({ ...stored, unsent })
    if (!sameChoices(before, this.current())) this.#announce()
    await this.sync()
    return this.current()
  }

  /**
   * What a window kept on its own before the host kept the choices, handed over once: each taken only for a harness
   * with no choice yet, here and in the account. Asked twice, the same end.
   */
  async adopt(modes: Readonly<Record<string, string>>): Promise<AccessChoices> {
    const stored = this.#read()
    const before = this.current()
    const offered = { ...stored.offered }
    for (const [harness, mode] of Object.entries(modes)) if (!before[harness] && !offered[harness]) offered[harness] = this.#choice(harness, mode)
    if (Object.keys(offered).length !== Object.keys(stored.offered).length) {
      this.#write({ ...stored, offered })
      this.#announce()
    }
    await this.sync()
    return this.current()
  }

  /**
   * The account said its choices (an `access-chosen` event, or an answer): they're what's kept, with any not sent yet
   * over them, unless this host heard a newer revision already.
   */
  heard({ account, choices: said, revision }: AccountAccessChoices): void {
    const stored = this.#read()
    if (stored.account === account && stored.revision !== undefined && revision < stored.revision) return
    const before = this.current()
    const choices = readable(said)
    if (stored.account !== account || stored.revision !== revision || !sameChoices(stored.choices, choices)) this.#write({ ...stored, choices, account, revision })
    if (!sameChoices(before, this.current())) this.#announce()
  }

  /**
   * Sends the account what it hasn't taken and reads its choices back: at start, on signing in, and when its stream
   * may have missed an event. One at a time; a failure leaves what's unsent for the next.
   */
  sync(): Promise<void> {
    const run = this.#syncing.then(() => this.#sync()).catch((error: Error) => {
      this.#deps.log?.("the account's access choices couldn't be read or written; kept here until the next sync", { error: error.message })
    })
    this.#syncing = run
    return run
  }

  async #sync(): Promise<void> {
    const account = await this.#deps.account()
    if (!account) return
    const sent = this.#read()
    // Each answer is the account's whole set after the write: what was sent is taken off what's left to send (unless
    // it was chosen again meanwhile) in the same write that keeps the answer.
    for (const kind of ["offered", "unsent"] as const) {
      const sending = sent[kind]
      if (!Object.keys(sending).length) continue
      const answer = await account.write(sending, kind === "offered")
      if (answer === undefined) return
      const now = this.#read()
      this.#write({ ...now, [kind]: Object.fromEntries(Object.entries(now[kind]).filter(([harness, choice]) => !same(sending[harness], choice))) })
      this.heard(answer)
    }
    const answer = await account.read()
    if (answer !== undefined) this.heard(answer)
  }

  #choice(harness: string, mode: string): AccessChoice {
    const access = this.#deps.modes(harness)?.find((offered) => offered.id === mode)?.access ?? accessTierOfModeId(mode)
    return access ? { mode, access } : { mode }
  }

  #announce(): void {
    this.#deps.announce(this.current())
  }

  #read(): Stored {
    let modified: number
    try {
      modified = statSync(this.#deps.file).mtimeMs
    } catch {
      return this.#stored
    }
    if (modified === this.#readAt) return this.#stored
    try {
      const parsed = StoredSchema.parse(JSON.parse(readFileSync(this.#deps.file, "utf8")))
      this.#stored = { choices: readable(parsed.choices), unsent: readable(parsed.unsent), offered: readable(parsed.offered) }
      if (parsed.revision !== undefined && parsed.account !== undefined) Object.assign(this.#stored, { account: parsed.account, revision: parsed.revision })
    } catch (error) {
      this.#deps.log?.("the access choices kept here couldn't be read; the account's are read again", { error: error instanceof Error ? error.message : String(error) })
    }
    this.#readAt = modified
    return this.#stored
  }

  #write(next: Stored): void {
    this.#stored = next
    mkdirSync(dirname(this.#deps.file), { recursive: true })
    const temporary = `${this.#deps.file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`)
    renameSync(temporary, this.#deps.file)
    this.#readAt = statSync(this.#deps.file).mtimeMs
  }
}

function sameChoices(left: AccessChoices, right: AccessChoices): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((harness) => same(left[harness], right[harness]))
}

/** The choices for every window and the web app's Macs: read, made, and a window's old copy handed over. */
export function declareAccessChoiceMethods(methods: MethodTable, store: AccessChoiceStore): void {
  methods.handle("mako:access-choices", () => store.current())
  methods.handle("mako:access-choose", (harness: string, mode: string) => store.choose(harness, mode))
  methods.handle("mako:access-adopt", (modes: Record<string, string>) => store.adopt(modes))
}
