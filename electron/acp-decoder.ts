import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { AcpUpdateDecoder } from "@mako/sessions/acp-decoder"
import type { JsonObject } from "./codex-app-json.js"
import type { LivePermissionResponse } from "./contracts/providers-acp.js"
import type { AcpAsk, AcpPlanDecoder, AcpVendorRequest, ProviderAcpSource } from "./providers/acp-source.js"

/** What a plan approval asks when the agent gives it no title of its own. */
export const PLAN_APPROVAL_TITLE = "Build the proposed plan?"

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
 * One ACP session's messages from the agent: its updates, decoded as a
 * store that saved them decodes them (`AcpUpdateDecoder`), and the requests
 * the agent waits on, which only a live session answers.
 */
export class AcpDecoder extends AcpUpdateDecoder<AcpPlanDecoder> {
  private readonly source: ProviderAcpSource | undefined

  constructor(source: ProviderAcpSource | undefined, settings?: ConstructorParameters<typeof AcpUpdateDecoder>[1]) {
    super(source, settings)
    this.source = source
  }

  /**
   * ACP's own permission request, as the desk asks it. Devin 3000.10.23 asks
   * to build a plan with a tool call carrying only its id, so a plan approval
   * is titled and kinded here when the agent leaves them out.
   */
  permission(request: RequestPermissionRequest): AcpAsk {
    const plan = this.plans?.approval?.(request)
    const ask: AcpAsk = {
      request: {
        title: request.toolCall.title ?? (plan ? PLAN_APPROVAL_TITLE : this.source?.permissionTitle?.(request)) ?? "The agent wants to use a tool",
        kind: request.toolCall.kind ?? (plan ? "switch_mode" : undefined),
        options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      },
    }
    if (plan) ask.request.implementsPlan = plan
    return ask
  }

  /** A vendor request; `undefined` when the provider does not own the method. */
  request(method: string, params: JsonObject): AcpVendorRequest | undefined {
    return this.source?.requests?.decode(method, params)
  }
}

/** What the agent is sent for the user's choice on a vendor request. */
export function acpAnswer(ask: AcpAsk, response: LivePermissionResponse): JsonObject {
  if (response.kind === "answers") return ask.answered?.(response.answers) ?? ask.dismissed ?? {}
  const chosen = response.optionId === null ? undefined : ask.answers?.find((answer) => answer.optionId === response.optionId)
  return chosen?.result ?? ask.dismissed ?? {}
}
