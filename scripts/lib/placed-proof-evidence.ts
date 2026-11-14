import { spawn } from "node:child_process"

/**
 * What the placed Fins proof reads on the device a Fin ran on: the marker file its approved command wrote, named for
 * the run and its word. A search has three outcomes, and only the first two say anything about the command: found, with
 * what the file holds; searched whole and absent; or failed, with why, when the search itself didn't run or didn't
 * finish (`docker exec` refused, no such container, `find` reporting an error). A failed search proves nothing, so the
 * proof's steps treat it as a failure in the allow case and the reject case alike: a rejection is proven by a search
 * that completed and found nothing, never by a search that couldn't look.
 */
export type Searched = { kind: "found"; holds: string } | { kind: "absent" } | { kind: "failed"; why: string }

/** A command run where the device's files are: its exit status and what it printed; a rejected spawn is a failed search. */
export type Exec = (command: string, args: readonly string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>

/** Runs a command here, as `find` under a host's data root on this computer, or `docker exec` into a container. */
export const localExec: Exec = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.once("error", (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }))
    child.once("exit", (status) => resolve({ status, stdout, stderr }))
  })

/** The same commands run inside a container, as its user: `docker exec <container> <command> <args>`, no shell between. */
export function containerExec(container: string, exec: Exec = localExec): Exec {
  return (command, args) => exec("docker", ["exec", container, command, ...args])
}

/**
 * Looks for a file of `name` anywhere under `root` on the device, through `exec`. `find`'s own exit status says whether
 * the search completed: a non-zero status, or a spawn that failed, is a failed search with `find`'s words; an empty
 * listing after a completed search is absence; a path is read whole, and a read that fails is a failed search too.
 */
export async function markerOn(exec: Exec, root: string, name: string): Promise<Searched> {
  const found = await exec("find", [root, "-name", name, "-type", "f"])
  if (found.status !== 0) return { kind: "failed", why: `find under ${root} ended ${found.status ?? "without a status"}: ${found.stderr.trim() || found.stdout.trim() || "nothing printed"}` }
  const path = found.stdout.split("\n").map((line) => line.trim()).find(Boolean)
  if (!path) return { kind: "absent" }
  const read = await exec("cat", [path])
  if (read.status !== 0) return { kind: "failed", why: `cat ${path} ended ${read.status ?? "without a status"}: ${read.stderr.trim() || "nothing printed"}` }
  return { kind: "found", holds: read.stdout.trim() }
}

/** Whether a search proves the allowed command ran: found, holding the command's word. */
export function allowed(searched: Searched, word: string): { ok: true } | { ok: false; why: string } {
  if (searched.kind === "failed") return { ok: false, why: `the device couldn't be searched: ${searched.why}` }
  if (searched.kind === "absent") return { ok: false, why: "the marker isn't on the device" }
  return searched.holds === word ? { ok: true } : { ok: false, why: `the marker holds ${JSON.stringify(searched.holds)}, not the command's word` }
}

/** Whether a search proves the rejected command never ran: a search that completed and found nothing, and only that. */
export function rejected(searched: Searched): { ok: true } | { ok: false; why: string } {
  if (searched.kind === "failed") return { ok: false, why: `the device couldn't be searched, so nothing says the command didn't run: ${searched.why}` }
  if (searched.kind === "found") return { ok: false, why: `the command ran though the person rejected it: the marker holds ${JSON.stringify(searched.holds)}` }
  return { ok: true }
}
