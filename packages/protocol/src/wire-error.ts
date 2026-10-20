/** Text that isn't the frame it should be; the message says how, for the refusal's detail. */
export class WireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WireError"
  }
}
