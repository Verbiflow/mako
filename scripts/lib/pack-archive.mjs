import { createPackage } from "@electron/asar"
import { randomBytes } from "node:crypto"
import { rename } from "node:fs/promises"
import { finished } from "node:stream/promises"

/**
 * Packs `source` into an ASAR archive at `dest`, whole once this resolves, and replaces `dest` in one rename.
 *
 * `createPackage` (@electron/asar 3.4.1) resolves when it has handed the last bytes to its write stream, not when the
 * stream has written them: its last step is `return out.end()`, so it answers the stream, still unfinished in every
 * one of 200 tries, and an archive read at once can be short. Reading `package.json` from such an archive filled the
 * unwritten bytes with zeros, and gate (9) of run 43578048397 failed in JSON.parse on them ("Unexpected token NUL").
 * So this writes beside `dest`, waits for the stream to finish, then renames it over `dest`, which a reader sees as the
 * old archive or the new one, never part of one.
 */
export async function packArchive(source, dest) {
  const partial = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.partial`
  await finished(await createPackage(source, partial))
  await rename(partial, dest)
}
