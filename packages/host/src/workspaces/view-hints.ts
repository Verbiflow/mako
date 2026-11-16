import { randomUUID } from "node:crypto"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { ViewDomain, ViewHintsStatus } from "../contracts/view-hints.js"
import type { MethodTable } from "../base/methods.js"

/** One publisher per host core, on the existing event stream. No timer or data scan of its own. */
export class ViewHints {
  private readonly epoch = randomUUID()
  private revision = 0
  private readonly positions = new Map<ViewDomain, number>()

  position(domain: ViewDomain) { return { epoch: this.epoch, revision: this.positions.get(domain) ?? 0 } }

  private readonly emit: (event: HostEvent) => void
  constructor(emit: (event: HostEvent) => void) { this.emit = emit }

  status(): ViewHintsStatus {
    return { version: 1, epoch: this.epoch, domains: ["apps", "sync", "output"] }
  }

  changed(domain: ViewDomain, fields: string[] = ["all"], keys?: string[]): void {
    this.positions.set(domain, this.revision + 1)
    this.emit({ type: "view-hint", hint: { epoch: this.epoch, revision: ++this.revision, domain, fields, ...keys && { keys } } })
  }
}

export function declareViewHints(methods: MethodTable, hints: ViewHints): void {
  methods.handle("mako:view-hints", (): ViewHintsStatus => hints.status())
}
