/** Live model tests require a deliberate opt-in, even for models advertised as free. */
export function allowLiveProviderTest(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MAKO_ALLOW_LIVE_PROVIDER_TESTS !== "1")
    throw new Error("This test can contact a real model. Use a scripted fixture, or explicitly set MAKO_ALLOW_LIVE_PROVIDER_TESTS=1.")
}
