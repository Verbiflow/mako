import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** How much of a file is hashed before the loop gets a turn: about a millisecond's work. */
const HASH_STEP = 1 << 20

/**
 * A file's SHA-256, read as a stream: the reads run off the host's thread and each piece is hashed between other
 * work, so a large file never holds the loop the way reading it whole and hashing it in one call does.
 */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path, { highWaterMark: HASH_STEP })) hash.update(chunk)
  return hash.digest("hex")
}
