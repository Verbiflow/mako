/**
 * How context reaches the agent, and how it is read back: one format, kept in
 * `@mako/sessions/context-wire` so the host reads what the window wrote.
 */
export {
  CONTEXT_VERSION,
  MARKER,
  escapeTags,
  marker,
  readMessage,
  unescapeTags,
  writeMessage,
  type ItemAttributes,
  type WireItem,
  type WireMessage,
} from "@mako/sessions/context-wire"
