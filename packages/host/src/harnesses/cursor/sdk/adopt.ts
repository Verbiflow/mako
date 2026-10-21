/**
 * The environment a child spawned ahead takes from a session's (`adopt`): the session's, as its spawn would have set
 * it, less the key, which the child read at its start and never leaves for its shells and tools, and with the ripgrep
 * the child found for itself unless the session names one.
 */
export function adoptedEnvironment(current: NodeJS.ProcessEnv, given: Readonly<Record<string, string>>) {
  const env = Object.fromEntries(Object.entries(given).filter(([name]) => name !== "CURSOR_API_KEY"))
  const ripgrep = given.CURSOR_RIPGREP_PATH ?? current.CURSOR_RIPGREP_PATH
  return ripgrep === undefined ? env : { ...env, CURSOR_RIPGREP_PATH: ripgrep }
}
