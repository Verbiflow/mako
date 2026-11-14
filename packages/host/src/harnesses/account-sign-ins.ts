import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { publishFile } from "../base/published-files.js"
import type { AccountRoot } from "./accounts-common.js"
import { hostWarn } from "../base/host-log.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"

/** A provider-verified profile login, never a resume grant. Native source/principal compatibility still gates every reopened prompt. No credential material. */
export interface VerifiedSignIn {
  harness: string
  account: string
  id: string
  sequence: number
}

const ReceiptSchema = z.object({ id: z.string().uuid(), sequence: z.number().int().positive() })
const StateSchema = z.object({ version: z.literal(1), sequence: z.number().int().nonnegative(), accounts: z.record(z.string(), ReceiptSchema) })

/** Native sign-in succeeded. Its caller must preserve that account even though the local recovery proof failed. */
export class SignInRecoveryWriteError extends Error {
  constructor(boundary: FailureBoundary) {
    super(`Sign-in succeeded, but Mako couldn't save its recovery receipt. Held work is kept. ${errorMessage(boundary)}`, { cause: boundary.error })
    this.name = "SignInRecoveryWriteError"
  }
}

/** The last verified login of each account, retained before listeners hear it. */
export class AccountSignIns {
  private readonly listeners = new Set<(receipt: VerifiedSignIn) => void>()
  private readonly root: AccountRoot
  constructor(root: AccountRoot) { this.root = root }

  private path(harness: string): string {
    this.root.provider(harness)
    return join(this.root.path, "sign-ins", `${harness}.json`)
  }

  private state(harness: string): z.infer<typeof StateSchema> | undefined {
    try { return StateSchema.parse(JSON.parse(readFileSync(this.path(harness), "utf8"))) }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, sequence: 0, accounts: {} }
      return undefined
    }
  }

  /** Read at hold creation, without an await in which another login could land. Missing/corrupt proof grants nothing. */
  proof(harness: string, account: string): VerifiedSignIn | undefined {
    this.root.dir(harness, account)
    const state = this.state(harness)
    const receipt = state?.accounts[account]
    return receipt && state && receipt.sequence <= state.sequence ? { harness, account, ...receipt } : undefined
  }

  sequence(harness: string): number | undefined {
    return this.state(harness)?.sequence
  }

  async keep(harness: string, account: string): Promise<VerifiedSignIn> {
    this.root.dir(harness, account)
    const previous = this.state(harness)
    if (!previous) throw new Error("The account's verified sign-in record could not be read; it was preserved.")
    const sequence = z.number().int().positive().parse(previous.sequence + 1)
    const receipt = { harness, account, id: randomUUID(), sequence }
    // Called under the account owner's provider mutation lock. Counter and receipt publish atomically across hosts.
    await publishFile(this.path(harness), JSON.stringify({ version: 1, sequence, accounts: { ...previous.accounts, [account]: { id: receipt.id, sequence } } }), { mode: 0o600, dirMode: 0o700 })
    return receipt
  }

  onSignedIn(listener: (receipt: VerifiedSignIn) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(receipt: VerifiedSignIn): void {
    for (const listener of this.listeners) {
      try { listener(receipt) }
      catch (error) { hostWarn("accounts", "a verified sign-in listener failed", { harness: receipt.harness, error: errorMessage({ error }) }) }
    }
  }
}
