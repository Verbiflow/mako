import { useEffect, useRef, useState } from "react"
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { desktop } from "@/state/desktop"
import { providerConnections, useProviderConnections } from "@/state/provider-connections"
import { cn } from "@/lib/utils"
import { connectionStatusText } from "@/lib/provider-connection-text"
import type { ProviderConnection, ProviderConnectionAction } from "@/lib/types"

const inputClass =
  "h-8 w-full rounded-md bg-raised px-2.5 font-mono text-code text-foreground ring-1 ring-hairline placeholder:font-sans placeholder:text-ui placeholder:text-faint focus:outline-none focus-visible:ring-border"

/**
 * A transport's own sign-in, rendered onto that provider's row in the Agents
 * list rather than into a section beneath it.
 *
 * These were a separate "Connections" card once, which put the single fact
 * that decides whether Cursor runs — does it hold a key — a screen below the
 * row that was meanwhile reporting a confident "Installed". "Installed"
 * answers whether the CLI exists on this machine, and that stops being worth
 * a column the moment it is true; whether the provider can actually answer a
 * prompt is what someone opens this page to find out. So the status slot
 * carries the connection when there is one, and the controls that change it
 * sit on the row they describe.
 *
 * Nothing here is Cursor's by name. Cursor's SDK is the only registered
 * connection today; any provider that registers one is rendered the same way
 * and the rest keep their availability text, which is the same footing the
 * rest of the provider registries are on.
 *
 * The pieces are separate exports because they land in three different places
 * on the row — the status slot, the control cluster, and the area under both.
 */

/** A provider is between states; the row says which rather than going blank. */
function workingAction(
  connection: ProviderConnection,
  busy: { provider: string; action: ProviderConnectionAction["kind"] } | undefined
): ProviderConnectionAction["kind"] | undefined {
  return busy?.provider === connection.provider ? busy.action : undefined
}

/** Only a key Mako minted or was handed is Mako's to revoke. */
function ownsCredential(connection: ProviderConnection): boolean {
  const { state } = connection
  return state.status === "signed-in" && (state.source === "mako" || state.source === "sdk")
}

/** A borrowed CLI login still offers a key, because Mako's own takes precedence. */
function offersSignIn(connection: ProviderConnection): boolean {
  const { state } = connection
  return state.status === "signed-out" || state.source === "cli"
}

/**
 * Where the credential lives and how long it is good for, in the slot that
 * would otherwise read "Installed". It truncates rather than wrapping: the
 * account is the front of the line and the part worth keeping when the
 * window is narrow.
 */
export function ConnectionStatus({ connection }: { connection: ProviderConnection }) {
  const busy = useProviderConnections((state) => state.busy)
  const working = workingAction(connection, busy)
  const { state } = connection
  const problem = state.status === "signed-out" ? state.problem : undefined

  const text =
    working === "sign-in-browser"
      ? "Waiting for the browser…"
      : working === "sign-in-key"
        ? `Checking the key with ${connection.label}…`
        : working === "sign-out"
          ? "Signing out…"
          : connectionStatusText(connection)

  return (
    <span
      className={cn(
        // Its own line under the provider's name. Beside the name it did not
        // fit: an account and where its key came from runs to eighty
        // characters, and the row is 644px with a transport label and
        // controls already on it, so every reading was a truncated one.
        "block truncate text-label",
        // A key that was refused is a warning. Never having signed in is not:
        // it is simply where a provider starts, and colouring it would put a
        // caution light on an untouched install.
        problem
          ? "text-caution"
          : state.status === "signed-in"
            ? "text-muted-foreground"
            : "text-faint"
      )}
    >
      {text}
    </span>
  )
}

/**
 * Refresh, sign out, and the two ways in. A settled connection keeps them
 * folded away until the row is pointed at or tabbed into — the width is
 * reserved either way, so revealing them moves nothing — while a row with
 * something to answer shows them without being asked.
 */
export function ConnectionControls({
  connection,
  keyOpen,
  onPasteKey,
}: {
  connection: ProviderConnection
  keyOpen: boolean
  onPasteKey: () => void
}) {
  const busy = useProviderConnections((state) => state.busy)
  const working = workingAction(connection, busy)
  const anyBusy = Boolean(busy)
  const signedIn = connection.state.status === "signed-in"
  const canStore = connection.secureStorage

  const act = (action: ProviderConnectionAction) =>
    providerConnections.act(connection.provider, action)

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 [transition:opacity_120ms_var(--ease-out)]",
        signedIn &&
          !keyOpen &&
          "opacity-0 focus-within:opacity-100 group-hover/harness:opacity-100"
      )}
    >
      {/* Sized to the row's text rather than to a form control: an inventory
          line should not grow 8px taller than its neighbours to hold a button
          nobody is looking at. */}
      <button
        type="button"
        aria-label={`Check ${connection.label} sign-in`}
        disabled={anyBusy}
        onClick={() => void act({ kind: "refresh" })}
        className="pressable flex size-6 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-60"
      >
        <RefreshCwIcon className={cn("size-3.5", working === "refresh" && "animate-spin")} />
      </button>
      {ownsCredential(connection) ? (
        <Action
          tone="ghost"
          size="xs"
          disabled={anyBusy}
          onClick={() => void act({ kind: "sign-out" })}
        >
          Sign out
        </Action>
      ) : null}
      {offersSignIn(connection) && !keyOpen ? (
        <>
          <Action tone="ghost" size="xs" disabled={anyBusy || !canStore} onClick={onPasteKey}>
            {signedIn ? "Use a key" : "Paste API key"}
          </Action>
          <Action
            tone={signedIn ? "ghost" : "solid"}
            size="xs"
            disabled={anyBusy || !canStore}
            onClick={() => void act({ kind: "sign-in-browser" })}
          >
            {signedIn ? "Sign in another account" : "Sign in with browser"}
          </Action>
        </>
      ) : null}
    </span>
  )
}

/** The dashboard a key is minted in, named by its own host. */
function keyHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

/**
 * The key field, opened from the row above it. A rejected key stays in place
 * and selected so the next attempt starts from the reason rather than from an
 * empty box.
 */
export function ConnectionKeyForm({
  connection,
  onClose,
}: {
  connection: ProviderConnection
  onClose: () => void
}) {
  const busy = useProviderConnections((state) => state.busy)
  const failure = useProviderConnections((state) => state.failures[connection.provider])
  const [key, setKey] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const working = workingAction(connection, busy)
  const anyBusy = Boolean(busy)
  const host = connection.keyUrl ? keyHost(connection.keyUrl) : null

  useEffect(() => {
    input.current?.focus()
  }, [])

  const save = async () => {
    const value = key.trim()
    if (!value) {
      input.current?.focus()
      return
    }
    const saved = await providerConnections.act(connection.provider, {
      kind: "sign-in-key",
      apiKey: value,
    })
    if (saved) {
      setKey("")
      onClose()
    } else input.current?.select()
  }

  return (
    <form
      className="animate-enter flex flex-col gap-2 pl-[26px]"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={input}
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value)
            if (failure) providerConnections.dismissFailure(connection.provider)
          }}
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          placeholder={`Paste a ${connection.label} API key`}
          aria-label={`${connection.label} API key`}
          aria-invalid={failure?.action === "sign-in-key" ? true : undefined}
          aria-describedby={`${connection.provider}-key-note`}
          disabled={anyBusy}
          className={cn(inputClass, failure?.action === "sign-in-key" && "ring-negative/60")}
        />
        <Action tone="solid" type="submit" disabled={anyBusy || !key.trim()}>
          {working === "sign-in-key" ? "Checking…" : "Save"}
        </Action>
        <Action tone="ghost" disabled={anyBusy} onClick={onClose}>
          Cancel
        </Action>
      </div>
      <span
        id={`${connection.provider}-key-note`}
        className="flex flex-wrap items-center gap-x-1.5 text-label leading-relaxed text-faint"
      >
        {connection.keyUrl && host ? (
          <button
            type="button"
            onClick={() => void desktop.openUrl(connection.keyUrl ?? "")}
            className="pressable inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            Create a key at {host}
            <ExternalLinkIcon className="size-3" />
          </button>
        ) : null}
        <span>
          {connection.keyUrl && host ? "· " : ""}
          Checked with {connection.label} before it is saved, then encrypted on this device using
          the system key store.
        </span>
      </span>
    </form>
  )
}

/**
 * Everything the row could not say in one truncated line: why a key was
 * refused, why no key can be saved here at all, what signing in changes, and
 * the failure of the last thing the user pressed.
 *
 * These live under the row rather than in it because each is a sentence, and
 * a sentence in a status slot is a status slot that has stopped being
 * scannable.
 */
export function ConnectionNotes({
  connection,
  keyOpen,
}: {
  connection: ProviderConnection
  keyOpen: boolean
}) {
  const failure = useProviderConnections((state) => state.failures[connection.provider])
  const { state } = connection
  const problem = state.status === "signed-out" ? state.problem : undefined
  const noStorage = !connection.secureStorage && offersSignIn(connection)

  if (!problem && !noStorage && !keyOpen && !failure) return null
  return (
    <div className="flex flex-col gap-1 pl-[26px] text-label leading-relaxed">
      {keyOpen ? <p className="text-faint">{connection.description}</p> : null}
      {problem ? (
        <p role="status" className="text-caution">
          {problem.message}
        </p>
      ) : null}
      {noStorage ? (
        <p className="text-caution">
          Keys cannot be saved on this machine because the system key store is unavailable. Set an
          API key in Mako&rsquo;s environment instead.
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-negative">
          {failure.message}
        </p>
      ) : null}
    </div>
  )
}
