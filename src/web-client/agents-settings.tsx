import { useEffect, useState } from "react"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import { errorMessage } from "@mako/host/contracts/error-message"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { WebHarnessIcon } from "./harness-icon"
import { WEB_HARNESSES, webHarnessLabel } from "./labels"
import { places, startable, type Place } from "./places"
import { Group, Row } from "./settings-rows"
import { macCall } from "./start"

type Mac = Extract<Place, { kind: "mac" }>

/** A harness as a Mac answers for it: still asking, its profile, or why it couldn't say. */
type Reading = { kind: "asking" } | { kind: "read"; profile: HarnessProfile } | { kind: "failed"; why: string }

/**
 * Settings › Agents on the phone and in the browser: each harness as every Mac that's on runs it, signed in or not and
 * with how many models it offers, as the desk's Settings › Agents lists it, one group a Mac. Its sign-in, keys and usage
 * are kept on the Mac (a credential never crosses the gateway), so a harness that isn't signed in says where to sign in.
 */
export function AgentsSettings() {
  const list = useAccountList((state) => state)
  const macs = places(list, false).filter((place): place is Mac => place.kind === "mac" && startable(place))
  if (!macs.length)
    return (
      <Group title="Agents" footer="Each Mac signs in to its own agents. Turn on a Mac to see them here.">
        <Row label="No Mac is on" detail="Agents are signed in on a Mac, and read from it while it's on." />
      </Group>
    )
  return macs.map((mac) => <MacAgents key={mac.deviceId} mac={mac} />)
}

function MacAgents({ mac }: { mac: Mac }) {
  const client = useWebClient()
  const [readings, setReadings] = useState<Record<string, Reading>>({})
  useEffect(() => {
    let current = true
    for (const harness of WEB_HARNESSES)
      void macCall<HarnessProfile>(client.gateway, client.deviceId, mac.deviceId, "mako:harness-tuning", [harness, undefined, false]).then(
        (profile) => current && setReadings((held) => ({ ...held, [harness]: { kind: "read", profile } })),
        (error) => current && setReadings((held) => ({ ...held, [harness]: { kind: "failed", why: errorMessage({ error }) } }))
      )
    return () => {
      current = false
    }
  }, [client, mac.deviceId])
  return (
    <Group title={`Agents on ${mac.name}`} footer={`Sign in, keys and usage are on ${mac.name}, in Settings › Agents there.`}>
      {WEB_HARNESSES.map((harness) => {
        const reading = readings[harness] ?? { kind: "asking" }
        return (
          <div key={harness} data-agent-row={harness} data-agent-state={reading.kind === "read" ? (reading.profile.available ? "signed-in" : "not-signed-in") : reading.kind}>
            <Row icon={<WebHarnessIcon harness={harness} className="size-4" />} label={webHarnessLabel(harness)} detail={readingWords(reading, mac.name)} />
          </div>
        )
      })}
    </Group>
  )
}

function readingWords(reading: Reading, mac: string): string {
  if (reading.kind === "asking") return `Asking ${mac}…`
  if (reading.kind === "failed") return reading.why
  const { profile } = reading
  if (!profile.available) return profile.error ?? `Not signed in on ${mac}`
  const models = profile.models.filter((model) => !model.unavailable).length
  return models ? `Signed in · ${models === 1 ? "1 model" : `${models} models`}` : "Signed in"
}
