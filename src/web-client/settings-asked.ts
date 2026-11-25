/**
 * The Settings section last asked for by name (a desk piece's `mako:settings`, as "git#pull-requests"), held until the
 * desk's Settings opens and takes it, and told to it while it's open.
 */
let asked: string | undefined
const listeners = new Set<(section: string) => void>()

export function askSettingsSection(section: string): void {
  asked = section
  for (const listener of listeners) listener(section)
}

/** The section asked for since Settings last opened, once. */
export function takeAskedSettingsSection(): string | undefined {
  const taken = asked
  asked = undefined
  return taken
}

export function onSettingsSectionAsked(listener: (section: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
