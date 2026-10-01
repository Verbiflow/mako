import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import { z } from "zod"
import { decodeAcpUpdate } from "./acp-notifications.js"
import type { JsonObject } from "./codex-app-json.js"
import { decoded, type Decoded } from "./contracts/native-decoding.js"
import type { AcpAsk, AcpPlanDecoder, AcpVendorRequest, ProviderAcpSource } from "./providers/acp-source.js"

/** The provider hooks the decoder reads. */
export type AcpDecoderHooks = Pick<ProviderAcpSource, "toolName" | "plans" | "requests" | "permissionTitle">

const RawSchema = z.json().catch(null)

/** A notification as captured for the decoder (`MAKO_NATIVE_CAPTURE`). */
export interface AcpNotificationRecord {
  method: string
  params: object
}

/** A request the agent waits on, as captured for the decoder. */
export interface AcpRequestRecord {
  request: string
  params: object
}

/**
 * One ACP session's messages from the agent, in the shared vocabulary: the
 * protocol's own updates, the provider's plan handover layered on them, and
 * the requests the agent waits on. Pure apart from the plan decoder's own
 * per-session state, so the live client and the fixture runner
 * (`npm run test:decoders`) decode the same messages the same way.
 */
export class AcpDecoder {
  private readonly plans: AcpPlanDecoder | undefined
  private readonly hooks: AcpDecoderHooks | undefined
  private readonly settings: () => SessionSettings | undefined

  constructor(hooks: AcpDecoderHooks | undefined, settings: () => SessionSettings | undefined = () => undefined) {
    this.hooks = hooks
    this.settings = settings
    this.plans = hooks?.plans?.()
  }

  /** A `session/update`. An unknown kind is `session/update/<kind>`, with the notification kept. */
  update(notification: SessionNotification): Decoded[] {
    const { update } = notification
    const toolName = update.sessionUpdate === "tool_call" ? this.hooks?.toolName?.(update) : undefined
    const out = decodeAcpUpdate(update, { settings: this.settings(), toolName }).map((item) =>
      item.kind === "unknown" ? decoded.unknown(`session/update/${item.type}`, RawSchema.parse(notification)) : item)
    for (const plan of this.plans?.update(update, notification.sessionId) ?? []) out.push(decoded.update(plan))
    return out
  }

  /** ACP's own permission request, as the desk asks it. */
  permission(request: RequestPermissionRequest): AcpAsk {
    const ask: AcpAsk = {
      request: {
        title: request.toolCall.title ?? this.hooks?.permissionTitle?.(request) ?? "The agent wants to use a tool",
        kind: request.toolCall.kind ?? undefined,
        options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      },
    }
    const plan = this.plans?.approval?.(request)
    if (plan) ask.request.implementsPlan = plan
    return ask
  }

  /** A vendor request; `undefined` when the provider does not own the method. */
  request(method: string, params: JsonObject): AcpVendorRequest | undefined {
    return this.hooks?.requests?.decode(method, params)
  }
}

/** What the agent is sent for the user's choice on a vendor request. */
export function acpAnswer(ask: AcpAsk, optionId: string | null): JsonObject {
  const chosen = optionId === null ? undefined : ask.answers?.find((answer) => answer.optionId === optionId)
  return chosen?.result ?? ask.dismissed ?? {}
}
