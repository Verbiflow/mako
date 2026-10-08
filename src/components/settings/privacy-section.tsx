import { useEffect, useState } from "react"
import { ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { telemetry } from "@/state/telemetry"
import type { TelemetryChoice, TelemetryOff, TelemetryState } from "../../../electron/contracts/telemetry.ts"

const OFF = {
  environment: "Off: DO_NOT_TRACK or MAKO_TELEMETRY is set where Mako runs.",
  fixture: "Off: this is a fixture desk, which sends nothing.",
  "no-cloud": "Off: this build has no Mako cloud to send to.",
} satisfies Record<TelemetryOff, string>

/** What this install tells Mako, and the two switches that stop it. */
export function PrivacySection() {
  const [state, setState] = useState<TelemetryState>()
  const [failed, setFailed] = useState<string>()

  useEffect(() => {
    void telemetry.state().then(setState, () => setFailed("Mako couldn't read these settings. Reopen Settings to try again."))
  }, [])

  const flip = (key: keyof TelemetryChoice) => {
    if (!state) return
    const choice = { [key]: !state[key] }
    setState({ ...state, ...choice })
    setFailed(undefined)
    void telemetry.choose(choice).then(setState, () => {
      setState(state)
      setFailed("That change wasn't saved. Try again.")
    })
  }

  const disabled = !state || Boolean(state.off)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ui leading-relaxed text-muted-foreground">
        Mako sends counts and names from its own code, never anything you or your agents wrote. Both are on until you
        turn them off.
      </p>
      <ListCard>
        <SettingRow
          title="Usage analytics"
          description="Which agents, models, modes and features you use, and how turns end and how long they take. Counted for this computer, by a one-way hash of its ID, or for your Mako account while you're signed in."
        >
          <Toggle label="Usage analytics" on={state?.usage ?? false} disabled={disabled} onChange={() => flip("usage")} />
        </SettingRow>
        <SettingRow
          title="Error reports"
          description="Crash messages and stack traces with file paths, emails and secrets taken out, the kinds of agent output Mako couldn't read, and how long calls to the Mako cloud take."
        >
          <Toggle label="Error reports" on={state?.errors ?? false} disabled={disabled} onChange={() => flip("errors")} />
        </SettingRow>
      </ListCard>
      <p className="text-label leading-relaxed text-faint">
        Never sent: prompts, replies, file contents, file and folder names, Thread titles, repository and branch names.
        Turning one off also drops whatever of it was still waiting to go.
      </p>
      {state?.off ? <p className="text-label text-faint">{OFF[state.off]}</p> : null}
      {failed ? (
        <p role="alert" className="text-label text-destructive">
          {failed}
        </p>
      ) : null}
    </div>
  )
}
