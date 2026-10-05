import type { AccountLaunch } from "../accounts.js"
import type { ExecutionContext } from "../contracts/execution-context.js"
import { confirmAccount } from "../execution-context.js"
import type { LiveDriverEvent, LiveSessionState } from "../shared.js"
import type { ProviderLiveDriver, ProviderStartOptions } from "./live-driver.js"
import { preparePrompt, preparePromptAsync } from "./prompt-dispatch.js"

interface AccountAdmission {
  resolve(provider: string): Promise<AccountLaunch>
  assertCurrent(provider: string, launch: AccountLaunch): Promise<void>
  /** The email listed for the launch account, compared with what the native process reports. */
  principal(provider: string, launch: AccountLaunch): Promise<string | undefined>
  mismatch(principal: string, expected: string): Promise<Error>
}

const accounts: AccountAdmission = {
  resolve: async provider => (await import("../accounts.js")).resolveAccountLaunch(provider, process.env),
  assertCurrent: async (provider, launch) => (await import("../accounts.js")).assertAccountLaunch(provider, launch),
  principal: async (provider, launch) => launch.selection.kind === "unavailable"
    ? undefined
    : (await import("../accounts.js")).accountPrincipal(provider, launch.account.name),
  mismatch: async (principal, expected) => new (await import("../accounts.js")).ExecutionIdentityMismatch(principal, expected),
}

interface Owner {
  opening: Promise<LiveSessionState>
  launch?: AccountLaunch
  closing?: Promise<void>
  cleanupFailed?: boolean
  opened?: boolean
  /** Read beside startup so confirming identity adds no launch latency. */
  expected?: Promise<string | undefined>
  /** Settled `expected`, so session events can be confirmed synchronously. */
  known?: { email: string | undefined }
  identity?: ExecutionContext["identity"]
  /** The newest session the driver reported, confirmed again once the email is known. */
  last?: LiveSessionState
}

/** Attach whether the reported identity is the launch account; unchanged until both are known. */
function confirmed(owner: Owner, session: LiveSessionState): LiveSessionState {
  const context = session.executionContext
  if (!context) return session
  owner.identity = context.identity
  owner.last = session
  const confirmation = owner.known && confirmAccount(context.identity, owner.known.email)
  return confirmation ? { ...session, executionContext: { ...context, confirmation } } : session
}

/** Shared admission for every registered driver, including future adapters.
 * Account selection is global; the environment is prepared once per process.
 * This owns startup/close races and warm-input admission, not native auth or
 * external-CLI exclusion. No checks run on streamed tokens. */
export function withExecutionAdmission(driver: ProviderLiveDriver, admission: AccountAdmission = accounts): ProviderLiveDriver {
  const owners = new Map<string, Owner>()
  const current = (id: string, owner: Owner): void => {
    if (owners.get(id) !== owner || owner.closing || owner.cleanupFailed)
      throw new Error("The agent execution owner changed or is closing. No input was dispatched.")
  }
  const start = (cwd: string, options: ProviderStartOptions): Promise<LiveSessionState> => {
    const id = options.conversationId
    if (owners.has(id)) return Promise.reject(new Error("This binding already has an execution owner."))
    const emit = options.emit && ((event: LiveDriverEvent) =>
      options.emit!(event.type === "live-session" && owners.get(id) === owner ? { ...event, session: confirmed(owner, event.session) } : event))
    const owner: Owner = { opening: Promise.resolve().then(async () => {
      const launch = await admission.resolve(driver.provider)
      current(id, owner)
      if (driver.launchEnvironment.kind === "unavailable" && launch.selection.kind === "selectable" && launch.selection.name !== null)
        throw new Error("This agent cannot apply the selected account environment. No native session was started.")
      owner.launch = launch
      await admission.assertCurrent(driver.provider, launch)
      current(id, owner)
      owner.expected = admission.principal(driver.provider, launch).catch(() => undefined).then(email => {
        owner.known = { email }
        // An identity reported before the email was read is confirmed now.
        if (owner.last && owners.get(id) === owner && !owner.closing && owner.identity?.kind !== "pending")
          emit?.({ type: "live-session", session: owner.last })
        return email
      })
      let session: LiveSessionState
      try {
        session = await driver.start(cwd, { ...options, emit, accountLaunch: {
          ...launch, env: { ...launch.env }, account: { ...launch.account }, selection: { ...launch.selection },
          credential: launch.credential && { ...launch.credential },
        } })
      } catch (error) {
        // A rejected handshake may already own a child. Release only after
        // cleanup succeeds; a concurrent Close owns and drains its own path.
        if (!owner.closing) {
          try { await driver.close(id) }
          catch (cleanup) {
            owner.cleanupFailed = true
            throw new AggregateError([error, cleanup], "Agent startup failed and its process could not close.", { cause: cleanup })
          }
        }
        throw error
      }
      owner.opened = true
      // Close owns late startup cleanup. Do not publish its returned session.
      current(id, owner)
      try {
        await admission.assertCurrent(driver.provider, launch)
        current(id, owner)
      } catch (error) {
        if (!owner.closing) {
          try { await driver.close(id) }
          catch (cleanup) { owner.cleanupFailed = true; throw cleanup }
        }
        throw error
      }
      return confirmed(owner, session)
    }) }
    owners.set(id, owner)
    void owner.opening.catch(() => {
      if (owners.get(id) === owner && !owner.closing && !owner.cleanupFailed) owners.delete(id)
    })
    return owner.opening
  }
  const close = (id: string): Promise<void> => {
    const owner = owners.get(id)
    if (!owner) return Promise.resolve().then(() => driver.close(id))
    if (owner.closing) return owner.closing
    const closing = Promise.resolve().then(async () => {
      // Let provider-owned cancellation interrupt an initialized startup, then
      // drain the late result before releasing this binding for replacement.
      let earlyFailure: { error: unknown } | undefined
      if (!owner.opened) {
        try { await driver.close(id) }
        catch (error) { earlyFailure = { error } }
      }
      await owner.opening.catch(() => undefined)
      try { await driver.close(id) }
      catch (error) {
        if (earlyFailure) throw new AggregateError([earlyFailure.error, error], "Agent startup and final cleanup failed.", { cause: error })
        throw error
      }
      // Drain even when early cancellation failed. Keep the failed owner for
      // an explicit cleanup retry; never lose a process that starts afterward.
      if (earlyFailure) throw earlyFailure.error
      if (owners.get(id) === owner) owners.delete(id)
    }).catch(error => { owner.cleanupFailed = true; throw error })
      .finally(() => { if (owner.closing === closing) owner.closing = undefined })
    owner.closing = closing
    return closing
  }
  const ready = async (id: string): Promise<Owner> => {
    const owner = owners.get(id)
    if (!owner) throw new Error("The agent execution owner is unavailable. Reconnect before sending.")
    current(id, owner)
    await owner.opening
    current(id, owner)
    if (!owner.launch) throw new Error("The agent launch account is unavailable. Reconnect before sending.")
    await admission.assertCurrent(driver.provider, owner.launch)
    const expected = await owner.expected
    current(id, owner)
    const confirmation = owner.identity && confirmAccount(owner.identity, expected)
    if (confirmation?.kind === "differs") throw await admission.mismatch(confirmation.principal, confirmation.expected)
    return owner
  }
  const steer = driver.steer
  const compaction = driver.compaction
  return {
    ...driver, start, close,
    prompt: async (id, ...args) => {
      const dispatch = args[3]
      const owner = await preparePromptAsync(dispatch, () => ready(id))
      preparePrompt(dispatch, () => current(id, owner))
      return driver.prompt(id, ...args)
    },
    steer: steer && (async (id, ...args) => { const owner = await ready(id); current(id, owner); return steer.call(driver, id, ...args) }),
    compaction: compaction?.kind === "supported"
      ? { kind: "supported", start: async (id, actionId) => { const owner = await ready(id); current(id, owner); return compaction.start(id, actionId) } }
      : compaction,
    // Approvals and Stop concern already admitted work and remain available
    // after a global account change. Never cancel it just to change accounts.
  }
}
