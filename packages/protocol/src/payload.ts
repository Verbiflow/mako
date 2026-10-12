import type { Json } from "./ids.js"

/**
 * A JSON value as its producer encoded it: an operation's input, a reply's
 * value, an event. Every hop between its producer and its consumer carries
 * the text as it came, and only its consumer decodes it, so a value is
 * encoded once and decoded once however many hops it crosses.
 */
export class Payload {
  private constructor(readonly text: string) {}

  static of(value: Json): Payload {
    return new Payload(JSON.stringify(value))
  }

  /** Text its producer already encoded as JSON, such as a host's reply, carried as it is. */
  static encoded(text: string): Payload {
    return new Payload(text)
  }

  /** The value, for the payload's consumer; throws when its producer sent text that isn't JSON. */
  decode(): Json {
    return JSON.parse(this.text)
  }
}
