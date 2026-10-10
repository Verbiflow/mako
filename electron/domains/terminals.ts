import { join } from "node:path"
import type { MethodTable } from "../host-methods.js"
import { TerminalClients } from "../terminal-clients.js"
import { hostClient } from "../host-client.js"
import { buildTag } from "../build-identity.js"
import type { TerminalCreateOptions } from "@mako/host/contracts/terminal"

type TerminalEvent = Parameters<ConstructorParameters<typeof TerminalClients>[2]>[0]

/** The terminal daemon, which outlives the host, and each client's view of it. */
export function openTerminals(buildDirectory: string, dataRoot: string, send: (event: TerminalEvent, owner?: string) => void): TerminalClients {
  return new TerminalClients(join(buildDirectory, "terminal-daemon.js"), join(dataRoot, "terminal"), send, buildTag())
}

export function declareTerminalMethods(methods: MethodTable, terminals: TerminalClients): void {
  const terminal = () => terminals.forOwner(hostClient())
  methods.handle("mako:terminal-list", () => terminal().list())
  methods.handle("mako:terminal-create", (options: TerminalCreateOptions) => terminal().create(options))
  methods.handle("mako:terminal-attach", (sessionId: string) => terminal().attach(sessionId))
  methods.handle("mako:terminal-detach", (sessionId: string) => terminal().detach(sessionId))
  methods.handle("mako:terminal-write", (sessionId: string, data: string) => terminal().write(sessionId, data))
  methods.handle("mako:terminal-acknowledge", (sessionId: string, sequence: number) => terminal().acknowledge(sessionId, sequence))
  methods.handle("mako:terminal-resize", (sessionId: string, cols: number, rows: number) => terminal().resize(sessionId, cols, rows))
  methods.handle("mako:terminal-kill", (sessionId: string) => terminal().kill(sessionId))
}
