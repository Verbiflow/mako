import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudArchiver, type ArchiveInputs, type CloudArchivePlans } from "../contracts/cloud-archive.js"
import type { CloudArchiveOutcome, CloudArchiveStep } from "../contracts/thread-lifecycle.js"
import type { EncodedValue } from "../contracts/runtime-value.js"
import type { CloudAccount } from "../usage/index.js"

/**
 * A cloud Thread archived by its person from this Mac: the procedure every device runs (`contracts/cloud-archive.ts`),
 * with this Mac's plans kept as files (`<data root>/cloud/archives/<op>.json`), its log, its account and its calls to
 * the Thread's machine.
 */

export type CloudArchivesOptions = {
  /** Where archives' plans are: `<data root>/cloud/archives`. */
  folder: string
  account(): CloudAccount | undefined
  cloud: {
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string, options?: { refuseUnstarted?: boolean }): Promise<EncodedValue>
    archiveInputs(threadId: string): ArchiveInputs
  }
  step(step: CloudArchiveStep): void
}

export class CloudArchives {
  readonly #options: CloudArchivesOptions
  readonly #archiver: CloudArchiver

  constructor(options: CloudArchivesOptions) {
    this.#options = options
    this.#archiver = new CloudArchiver({
      plans: filePlans(options.folder),
      account: () => {
        const account = options.account()
        if (!account) throw new Error("This Mac signed out of Mako Cloud.")
        return account
      },
      callThread: (...args) => options.cloud.callThread(...args),
      step: (step) => options.step(step),
      log: { info: (message, fields) => hostLog("archives", message, fields), warn: (message, fields) => hostWarn("archives", message, fields) },
      self: "This Mac",
    })
  }

  /** Archives the cloud Thread `thread` under `op`, or answers how its archive went. */
  archive(thread: string, op: string, anyway = false): Promise<CloudArchiveOutcome> {
    return this.#archiver.archive(thread, op, anyway, () => this.#options.cloud.archiveInputs(thread))
  }

  /** Settles every archive a stopped host left under way, as its plan stands. */
  settle(): Promise<void> {
    return this.#archiver.settle()
  }
}

/** Plans as files in `folder`, each written whole beside itself and renamed over the last. */
function filePlans(folder: string): CloudArchivePlans {
  return {
    read: (op) => readFile(join(folder, `${op}.json`), "utf8"),
    write: async (op, text) => {
      await mkdir(folder, { recursive: true })
      const file = join(folder, `${op}.json`)
      await writeFile(`${file}.tmp`, text)
      await rename(`${file}.tmp`, file)
    },
    list: async () => (await readdir(folder)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)),
  }
}
