import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Mako's own folder for this user, `~/.mako`: what every host of the user
 * shares (the record store, decoded views, session memory, the installed
 * readings). This is only the default. A host hands down its user root
 * (`HostEnvironment.userRoot`), which for a host isolated in a data root of
 * its own (a test's, a proof's) is that data root, so it reaches nothing of
 * the person's; scripts read the person's.
 */
export function makoUserRoot(home = homedir()): string {
  return join(home, ".mako")
}
