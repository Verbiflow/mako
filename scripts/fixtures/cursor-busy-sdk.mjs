export class ConfigurationError extends Error {}
export class AgentBusyError extends Error {}
export class AgentNotFoundError extends Error {}
export class AuthenticationError extends Error {}
export class CursorSdkError extends Error {}
export class NetworkError extends Error {}
export class RateLimitError extends Error {}
export const Cursor = { configure() {} }
export const Agent = {
  async resume(agentId, options) {
    return {
      agentId, model: options.model,
      async send(_message, sendOptions) {
        if (sendOptions.local?.force) throw new ConfigurationError("A force takeover was attempted")
        throw new Error(`Agent ${agentId} already has active run`)
      },
      close() {},
    }
  },
}
