import type { Plugin } from "vite"

export function trustedLocalOrigins(urls: Iterable<string>): Set<string>
export function isTrustedOrigin(origins: Set<string>, origin?: string): boolean
export function webHostProxy(
  socket: string,
  options?: { refuse?: (channel: string) => string | undefined },
): Plugin
