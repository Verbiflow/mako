import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js"

/** Every command in the pinned Chrome DevTools Protocol snapshot. */
export type CdpCommand = keyof ProtocolMapping.Commands

/** The exact argument tuple Chrome declares for one command. */
export type CdpCommandArguments<Method extends CdpCommand> =
  ProtocolMapping.Commands[Method]["paramsType"]

/** The exact result Chrome declares for one command. */
export type CdpCommandResult<Method extends CdpCommand> =
  ProtocolMapping.Commands[Method]["returnType"]

/**
 * A complete, protocol-versioned CDP call surface. Implementations still
 * validate external JSON at their transport boundary; these generated types
 * make host and library callers use the command's real parameter contract.
 */
export interface TypedCdpCall {
  <Method extends CdpCommand>(
    method: Method,
    ...args: CdpCommandArguments<Method>
  ): Promise<CdpCommandResult<Method>>
}
