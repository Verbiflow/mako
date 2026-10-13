/**
 * The heartbeat of every connection to a gateway, a runtime's or a client's, and the gateway's answer.
 * Both are fixed text, so a gateway can answer without reading the frame or waking whatever holds the
 * connection. Neither reaches a link's reader.
 */
export const PING = '{"type":"ping"}'
export const PONG = '{"type":"pong"}'
