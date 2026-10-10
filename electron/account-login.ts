/**
 * Adding an account, or signing one in again, without a terminal.
 *
 * The provider signs one profile in its own way: its CLI runs its login (in
 * a terminal Mako provides, for a CLI that asks only through one) or its SDK
 * runs a browser flow, and the credentials land where that provider always
 * keeps them. Mako relays only the sign-in page's address and anything the
 * person pastes back: the code the page shows, or the address the browser
 * ended on. Mako never reads a token here.
 *
 * A sign-in ends one of three ways. It finishes: the profile must then pass
 * the provider's own check before it is listed. It is cancelled, or the
 * provider gives up: a new profile is removed, and an account being signed
 * in again keeps what it had. Or the host stops first: a new profile was
 * never listed, and the next sign-in for that provider removes it.
 */

import { randomUUID } from "node:crypto"
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { homedir } from "node:os"
import { promisify } from "node:util"
import type { AccountHarness, AccountLogin, AccountLoginResult } from "./account-types.js"
import { accountLoginLanded, discardAccountLogin, finishAccountLogin, prepareAccountLogin } from "./accounts.js"
import { environmentForExecutable } from "./executable.js"
import type { AccountLoginCommand, AccountLoginTarget, AccountLoginTask } from "./providers/account-capability.js"
import { spawnProviderProcess } from "./providers/provider-process.js"
import { providerHost } from "./providers/index.js"
import { onLinux, onMac, onWindows } from "./platform.js"

const run = promisify(execFile)

/** Long enough to find a password manager and approve on a phone; a forgotten tab still ends. */
const LOGIN_TIMEOUT_MS = 15 * 60_000
/** The provider names its sign-in page at once; past this the card shows without one. */
const URL_WAIT_MS = 8_000
const OUTPUT_LIMIT = 64_000
/** How often a CLI that keeps running after a pasted code is checked for having signed in. */
const LANDED_POLL_MS = 1_000

/** A finished sign-in still answers a waiter that reconnected after it ended. */
const FINISHED_KEPT_MS = 60_000

/** How the provider's side of a sign-in stopped, before Mako checks the profile. */
type Ending =
  | { kind: "finished"; landed: boolean }
  | { kind: "failed"; detail?: string }
  | { kind: "refused" }

/** One running provider sign-in, whatever drives it. */
interface Session {
  announced: Promise<string | undefined>
  ended: Promise<Ending>
  stop(): void
  paste?(text: string): void
}

interface RunningLogin {
  info: AccountLogin
  session: Session
  result: Promise<AccountLoginResult>
  done: boolean
  cancel(): void
}

const logins = new Map<string, RunningLogin>()

function label(harness: AccountHarness): string {
  return providerHost.accountCapabilities.get(harness)?.label ?? harness
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!onWindows() && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM")
      return
    } catch {
      // The group is gone; signal the child alone.
    }
  }
  child.kill("SIGTERM")
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences are what is being removed.
const TERMINAL_STYLING = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * The first complete web address the provider prints, without terminal
 * styling. Output arrives in chunks, so an address counts only once
 * something ends it.
 */
function signInUrl(output: string): string | undefined {
  return output.replace(TERMINAL_STYLING, "").match(/https:\/\/[^\s"'<>]+(?=[\s"'<>])/)?.[0]
}

/**
 * The CLI under a pseudo-terminal from the system's `script`. Node's pipes
 * are sockets on macOS, which `script` cannot read its input from, so `cat`
 * hands it a real pipe.
 */
interface SpawnedCommand {
  executable: string
  args: string[]
}

function terminalCommand(executable: string, args: readonly string[]): SpawnedCommand {
  if (onMac())
    return { executable: "/bin/sh", args: ["-c", 'cat | exec script -q /dev/null "$@"', "sh", executable, ...args] }
  if (onLinux()) {
    const quoted = [executable, ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ")
    return { executable: "/bin/sh", args: ["-c", 'cat | exec script -q -e -c "$0" /dev/null', quoted] }
  }
  throw new Error("This sign-in needs a terminal, which Mako can't provide on this system yet.")
}

/** Queries a terminal answers by itself; a CLI drawing its prompt waits on them. */
const TERMINAL_ANSWERS: ReadonlyArray<[string, string]> = [
  ["\u001b[6n", "\u001b[1;1R"],
  ["\u001b[c", "\u001b[?1;2c"],
]

function commandSession(
  harness: AccountHarness,
  launch: AccountLoginCommand,
  landed: () => Promise<boolean>
): Session {
  const command: SpawnedCommand = launch.terminal ? terminalCommand(launch.executable, launch.args) : { executable: launch.executable, args: [...launch.args] }
  const env = environmentForExecutable(launch.executable, launch.env)
  if (launch.terminal) env.TERM = "xterm-256color"
  const child = spawnProviderProcess(command.executable, command.args, {
    cwd: homedir(),
    env,
    detached: !onWindows(),
    windowsHide: true,
  }, { kind: "account-login", owner: harness })

  let output = ""
  let pastedAt: number | undefined
  let refused = false
  let landedFirst = false
  let polling: ReturnType<typeof setInterval> | undefined
  let announce: (url: string | undefined) => void = () => {}
  const announced = new Promise<string | undefined>((resolve) => { announce = resolve })
  const listen = (chunk: Buffer) => {
    const text = chunk.toString("utf8")
    if (output.length < OUTPUT_LIMIT) output += text
    if (launch.terminal)
      for (const [query, answer] of TERMINAL_ANSWERS) if (text.includes(query)) child.stdin.write(answer)
    const url = signInUrl(output)
    if (url) announce(url)
    if (pastedAt !== undefined && launch.refusedCode?.test(output.slice(pastedAt).replace(TERMINAL_STYLING, ""))) {
      refused = true
      terminate(child)
    }
  }
  child.stdout.on("data", listen)
  child.stderr.on("data", listen)
  child.stdin.on("error", () => {})

  const ended = new Promise<Ending>((resolve) => {
    child.once("error", () => resolve({ kind: "failed" }))
    child.once("close", (code) => {
      clearInterval(polling)
      announce(undefined)
      if (landedFirst) resolve({ kind: "finished", landed: true })
      else if (refused) resolve({ kind: "refused" })
      else resolve(code === 0 ? { kind: "finished", landed: false } : { kind: "failed" })
    })
  })

  const session: Session = {
    announced,
    ended,
    stop: () => terminate(child),
  }
  if (launch.paste)
    session.paste = (text) => {
      pastedAt = output.length
      child.stdin.write(`${text}${launch.terminal ? "\r" : "\n"}`)
      // A CLI with no status command may keep running after it signs in;
      // the profile itself says when it has.
      if (!launch.statusArgs && polling === undefined)
        polling = setInterval(() => {
          void landed().then((yes) => {
            if (!yes || landedFirst) return
            landedFirst = true
            terminate(child)
          })
        }, LANDED_POLL_MS)
    }
  return session
}

function taskSession(launch: AccountLoginTask): Session {
  const controller = new AbortController()
  let announce: (url: string | undefined) => void = () => {}
  const announced = new Promise<string | undefined>((resolve) => { announce = resolve })
  const ended = launch.run({ page: (url) => announce(url) }, controller.signal).then(
    (): Ending => ({ kind: "finished", landed: true }),
    (error): Ending => ({ kind: "failed", detail: error instanceof Error ? error.message : undefined })
  ).finally(() => announce(undefined))
  return { announced, ended, stop: () => controller.abort() }
}

/**
 * Start a sign-in for `harness`: into a new profile, or into the account
 * `renew` names when its login expired. Resolves once the provider has named
 * its sign-in page (or has had time to), with what the card needs to show;
 * `waitAccountLogin` resolves when it ends.
 */
export async function startAccountLogin(harness: AccountHarness, renew?: string): Promise<AccountLogin> {
  // One per provider: a second would race the first for the CLI's callback port.
  for (const login of logins.values())
    if (login.info.harness === harness && !login.done) await cancelAccountLogin(login.info.id)
  const target: AccountLoginTarget = renew === undefined
    ? { name: `account-${randomUUID().slice(0, 8)}`, renew: false }
    : { name: renew, renew: true }
  const { launch, previousEmail } = await prepareAccountLogin(harness, target)
  const id = randomUUID()
  let session: Session
  try {
    session = launch.kind === "task"
      ? taskSession(launch)
      : commandSession(harness, launch, () => accountLoginLanded(harness, target))
  } catch (error) {
    await discardAccountLogin(harness, target)
    throw error
  }

  let cancelled = false
  let expired = false
  const timer = setTimeout(() => { expired = true; session.stop() }, LOGIN_TIMEOUT_MS)
  const name = label(harness)
  const again = target.renew ? "Sign in again" : "Add the account again"

  const result = session.ended.then(async (ending): Promise<AccountLoginResult> => {
    clearTimeout(timer)
    try {
      if (cancelled || expired) {
        await discardAccountLogin(harness, target)
        if (expired) throw new Error(`${name} sign-in timed out. ${again} when you're ready.`)
        return { status: "cancelled" }
      }
      if (ending.kind !== "finished") {
        await discardAccountLogin(harness, target)
        if (ending.kind === "refused")
          throw new Error(`${name} didn't accept that code. ${again} and paste the newest code the page shows.`)
        throw new Error(ending.detail ? `${name} sign-in didn't finish: ${ending.detail}` : `${name} sign-in didn't finish. Try again.`)
      }
      try {
        const options: Parameters<typeof finishAccountLogin>[2] = { confirmed: ending.landed }
        if (previousEmail !== undefined) options.previousEmail = previousEmail
        if (launch.kind === "command" && launch.statusArgs) {
          const statusArgs = [...launch.statusArgs]
          options.verify = async (env) => {
            await run(launch.executable, statusArgs, {
              cwd: homedir(),
              env: environmentForExecutable(launch.executable, env),
              timeout: 20_000,
            }).catch(() => {
              throw new Error(`${name} finished, but the login didn't check out. ${again}.`)
            })
          }
        }
        return await finishAccountLogin(harness, target, options)
      } catch (failure) {
        await discardAccountLogin(harness, target).catch(() => {})
        throw failure
      }
    } finally {
      login.done = true
      setTimeout(() => logins.delete(id), FINISHED_KEPT_MS).unref()
    }
  })
  // A sign-in nobody is waiting on still settles; its failure is the waiter's to show.
  result.catch(() => {})

  const info: AccountLogin = {
    id,
    harness,
    openPage: launch.kind === "task" || launch.opensBrowser === false,
  }
  if (target.renew) info.renew = target.name
  if (launch.kind === "command" && launch.paste) {
    info.paste = launch.paste
    if (launch.pasteOnly) info.pasteOnly = true
  }
  const login: RunningLogin = {
    info,
    session,
    result,
    done: false,
    cancel: () => { cancelled = true; session.stop() },
  }
  logins.set(id, login)

  let waited: ReturnType<typeof setTimeout> | undefined
  const url = await Promise.race([
    session.announced,
    new Promise<undefined>((resolve) => { waited = setTimeout(() => resolve(undefined), URL_WAIT_MS) }),
  ])
  clearTimeout(waited)
  if (url) login.info.url = url
  // A provider that failed before the card could show reports why here.
  if (login.done) await result
  return { ...login.info }
}

/** How the sign-in ended; a failure rejects with what to tell the user. */
export async function waitAccountLogin(id: string): Promise<AccountLoginResult> {
  const login = logins.get(id)
  if (!login) throw new Error("That sign-in already ended. Refresh to see your accounts.")
  return login.result
}

/** What the sign-in page showed, or the address the browser ended on, for a provider that reads one. */
export function submitAccountLoginCode(id: string, code: string): void {
  const login = logins.get(id)
  if (!login || login.done) throw new Error("That sign-in already ended. Start it again.")
  if (!login.session.paste) throw new Error(`${label(login.info.harness)} doesn't take anything pasted.`)
  const clean = code.trim()
  if (!clean || /\s/.test(clean))
    throw new Error(login.info.paste === "address" ? "Paste the whole address from the browser's address bar." : "Paste the whole code from the sign-in page.")
  if (login.info.paste === "address" && !/^https?:\/\//.test(clean))
    throw new Error("Paste the address from the browser's address bar, starting with http.")
  login.session.paste(clean)
}

/** Stop a sign-in; a new profile is removed. Stopping one that ended changes nothing. */
export async function cancelAccountLogin(id: string): Promise<void> {
  const login = logins.get(id)
  if (!login) return
  if (!login.done) login.cancel()
  await login.result.catch(() => {})
}
