/**
 * Whether the host takes new work. The application lifecycle closes it while
 * the host stops its agents to quit, restart or install, and whatever starts
 * work asks it first. Composition makes one and hands it to both; one made on
 * its own, as a test makes it, admits everything.
 */
export class Admission {
  private refusing: () => boolean = () => false

  /** From now on, refuse new work whenever `refusing` says so. */
  follow(refusing: () => boolean): void {
    this.refusing = refusing
  }

  get closed(): boolean {
    return this.refusing()
  }

  assert(): void {
    if (this.refusing()) throw new Error("Mako is preparing to close or install an update. Your prompt was not sent.")
  }
}
