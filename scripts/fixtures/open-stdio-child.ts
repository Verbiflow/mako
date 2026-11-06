// Prints what the open guard reads in a process whose stdin, stdout and stderr are pipes. argv: whether stdin has
// ended first ("ended" or "open"), and a Unix socket to stay connected to, a referenced pipe that isn't stdio.
import { once } from "node:events"
import { connect } from "node:net"
import { leftOpen } from "../open-resources.ts"

const [stdin, path] = process.argv.slice(2)
if (path) {
  await once(connect(path), "connect")
  // The connect request is still finishing as its event fires.
  await new Promise((resolve) => setImmediate(resolve))
}
if (stdin === "ended") {
  process.stdin.resume()
  await once(process.stdin, "close")
}
process.stdout.write(JSON.stringify(leftOpen()), () => process.exit(0))
