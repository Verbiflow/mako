import { useState } from "react"
import { CopyIcon, ExternalLinkIcon, LoaderCircleIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import {
  accounts as accountActions,
  accountGroups,
  useAccounts,
  usageKey,
  type AccountSignIn,
  type ProviderAccount,
} from "@/state/accounts"
import { Action, ListCard } from "@/components/ui/kit"
import { Collapse } from "@/components/ui/collapse"
import { Shimmer } from "@/components/ui/shimmer"
import { HarnessAccounts } from "@/components/identity/account-usage"
import { accountIdentity, isSignedOut } from "@/lib/account-identity"
import { cn } from "@/lib/utils"

/**
 * One harness's logins inside its Settings → Agents row: the same account
 * entries and limits as the identity menu, plus adding, signing in again and
 * removing logins. Signing in is a browser sign-in the host runs, shown as
 * one card in place of the Add button until it ends. `hint` says how to
 * change a login the CLI owns, for harnesses whose row has no sign-in
 * controls of its own.
 */
export function ProviderAccounts({
  providerId,
  hint = true,
}: {
  providerId: string
  hint?: boolean
}) {
  const provider = useAccounts((state) =>
    state.providers.find((entry) => entry.provider === providerId)
  )
  const group = useAccounts((state) =>
    accountGroups(state).find((entry) => entry.provider.provider === providerId)
  )
  const signIn = useAccounts((state) =>
    state.signIn?.harness === providerId ? state.signIn : undefined
  )
  if (!provider) return null

  const selectable = provider.mode === "selectable"
  const addable = selectable && provider.nativeLogin === true
  const several = (group?.accounts.length ?? 0) > 1
  const renewing = signIn?.renew
    ? group?.accounts.find((account) => account.name === signIn.renew)
    : undefined
  return (
    <div className="@container flex flex-col gap-2">
      {!addable && hint ? (
        <p className="text-ui leading-relaxed text-faint">
          {provider.readOnlyReason ? `${provider.readOnlyReason} ` : `${provider.label} owns this login. `}
          To change it, run{" "}
          <code className="font-mono text-muted-foreground">
            {provider.loginCommand}
          </code>{" "}
          in a terminal, then refresh.
        </p>
      ) : null}
      {group ? (
        <HarnessAccounts
          group={group}
          heading={false}
          actions={(account) =>
            selectable && account.source === "mako" && !account.missing && !account.removing ? (
              <AccountActions account={account} renewable={addable} />
            ) : null
          }
        />
      ) : addable ? null : (
        <ListCard className="py-3 text-ui text-faint">
          No {provider.label} login found.
        </ListCard>
      )}
      {addable ? (
        signIn ? (
          <SignInCard
            signIn={signIn}
            label={provider.label}
            who={renewing ? accountIdentity(renewing) : undefined}
          />
        ) : group ? (
          <Action
            size="xs"
            onClick={() => void accountActions.signIn(providerId)}
            className="-ml-1.5 self-start font-normal"
          >
            <PlusIcon className="text-faint" />
            Add {provider.label} account
          </Action>
        ) : (
          <ListCard className="flex items-center justify-between gap-4 py-3">
            <span className="text-ui text-muted-foreground">
              No {provider.label} account yet.
            </span>
            <Action tone="solid" size="xs" onClick={() => void accountActions.signIn(providerId)}>
              Sign in
            </Action>
          </ListCard>
        )
      ) : null}
      {selectable && several ? (
        <p className="text-label leading-relaxed text-faint">
          Sessions switch to the selected account with their next message,
          or when the work they're doing ends.
        </p>
      ) : null}
    </div>
  )
}

/**
 * A saved login's own controls, shown while its row is pointed at. A signed
 * out login offers signing in again on its row instead, where it stays in
 * view.
 */
function AccountActions({ account, renewable }: { account: ProviderAccount; renewable: boolean }) {
  const usage = useAccounts((state) => state.usage[usageKey(account.harness, account.name)])
  const busy = useAccounts((state) => Boolean(state.busy))
  const signingIn = useAccounts((state) => state.signIn?.phase === "starting")
  return (
    <>
      {renewable && !isSignedOut(account, usage) ? (
        <Action
          size="xs"
          tone="ghost"
          disabled={busy || signingIn}
          onClick={() => void accountActions.signIn(account.harness, account.name)}
          className="font-normal text-faint"
        >
          Sign in again
        </Action>
      ) : null}
      {account.active ? null : (
        <Action
          size="xs"
          tone="ghost"
          aria-label={`Remove ${account.email ?? account.name}`}
          disabled={busy}
          onClick={() => void accountActions.remove(account.harness, account.name)}
          className="font-normal text-faint hover:not-disabled:text-negative"
        >
          Remove
        </Action>
      )}
    </>
  )
}

const CARD =
  "animate-enter rounded-lg bg-shell/55 px-4 py-3.5 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]"

function pageHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * The sign-in under way. The provider or the window opened the page; this
 * says so, offers it again for a closed tab and as a link for another
 * browser, and takes whatever the page hands back by hand: a code, or the
 * address the browser ended on.
 */
function SignInCard({ signIn, label, who }: { signIn: AccountSignIn; label: string; who?: string }) {
  if (signIn.phase === "failed")
    return (
      <div role="alert" className={cn(CARD, "flex items-start gap-3")}>
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium text-foreground">
            {signIn.renew ? "You weren't signed in again" : "The account wasn't added"}
          </p>
          <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
            {signIn.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Action tone="solid" size="xs" onClick={() => void accountActions.signIn(signIn.harness, signIn.renew)}>
              Try again
            </Action>
            <Action size="xs" onClick={() => accountActions.cancelSignIn()}>
              Dismiss
            </Action>
          </div>
        </div>
      </div>
    )
  const waiting = signIn.phase === "waiting" ? signIn : undefined
  const login = waiting?.login
  const pasteFirst = login?.pasteOnly === true && login.paste !== undefined
  const host = pageHost(login?.url)
  const title = !waiting
    ? <Shimmer text={`Opening ${label} sign-in…`} />
    : pasteFirst
      ? "Sign in, then paste the code"
      : "Continue in your browser"
  const body = signIn.renew
    ? `Sign in as ${who ?? "this account"} to bring it back. Sessions already running keep the login they started with.`
    : `Sign in with the ${label} account you want to add. It shows up here when you're done, and your current login stays as it is.`
  return (
    <div role="status" aria-live="polite" className={cn(CARD, "flex items-start gap-3")}>
      <LoaderCircleIcon
        className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">{body}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {login?.url ? (
            <>
              <Action
                tone="outline"
                size="xs"
                title={host ? `Opens ${host}` : undefined}
                onClick={() => accountActions.openSignInPage()}
              >
                <ExternalLinkIcon className="text-faint" />
                Open sign-in page
              </Action>
              <Action size="xs" onClick={() => void accountActions.copySignInLink()}>
                <CopyIcon className="text-faint" />
                Copy link
              </Action>
            </>
          ) : null}
          <Action size="xs" onClick={() => accountActions.cancelSignIn()}>
            Cancel
          </Action>
        </div>
        {login?.url ? (
          <p className="mt-2 text-label leading-relaxed text-faint">
            Signed in to {host ?? label} as someone else? Copy the link into a
            private window.
          </p>
        ) : null}
        {waiting && login?.paste ? (
          <PasteEntry
            kind={login.paste}
            label={label}
            first={pasteFirst}
            sent={waiting.codeSent}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * What the page hands back by hand. Where pasting is the only way back the
 * field is the next step; elsewhere it is tucked away until asked for,
 * since the browser usually hands back by itself.
 */
function PasteEntry({
  kind,
  label,
  first,
  sent,
}: {
  kind: "code" | "address"
  label: string
  first: boolean
  sent: boolean
}) {
  const [open, setOpen] = useState(first)
  const [value, setValue] = useState("")
  const [sending, setSending] = useState(false)
  if (sent)
    return (
      <p className="mt-3 border-t border-hairline pt-3 text-label text-muted-foreground">
        <Shimmer text={kind === "address" ? "Finishing sign-in…" : "Checking the code…"} />
      </p>
    )
  const submit = async () => {
    if (!value.trim() || sending) return
    setSending(true)
    try {
      if (await accountActions.submitSignInCode(value)) setValue("")
    } finally {
      setSending(false)
    }
  }
  const prompt = kind === "address"
    ? `The browser didn't return to ${label}?`
    : "The page showed a code instead?"
  const fieldLabel = kind === "address"
    ? "Paste the address from your browser's address bar"
    : first
      ? "When the page shows a code, paste it here"
      : "Paste the code from the sign-in page"
  return (
    <div className="mt-3 border-t border-hairline pt-3">
      {open ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="pressable text-label text-faint underline-offset-2 hover:text-muted-foreground hover:underline"
        >
          {prompt}
        </button>
      )}
      <Collapse open={open}>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label htmlFor="account-sign-in-paste" className="text-label text-muted-foreground">
            {fieldLabel}
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="account-sign-in-paste"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              disabled={sending}
              placeholder={kind === "address" ? "http://localhost:…" : "Code"}
              className="h-7 min-w-0 flex-1 rounded-md bg-raised px-2 font-mono text-code text-foreground ring-1 ring-hairline placeholder:font-sans placeholder:text-ui placeholder:text-faint focus:outline-none focus-visible:ring-border"
            />
            <Action tone="solid" size="sm" type="submit" disabled={!value.trim() || sending}>
              Continue
            </Action>
          </div>
        </form>
      </Collapse>
    </div>
  )
}
