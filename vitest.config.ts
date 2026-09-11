import { defineConfig } from "vitest/config";

/**
 * Deliberately does NOT load vite.config.ts.
 *
 * The app's vite config includes the Cloudflare plugin, which opens a remote
 * proxy session for the Workers AI binding and therefore requires Cloudflare
 * credentials. These are unit tests over pure functions (HMAC verification and
 * payload normalisation), so they should run in plain Node with no account and no
 * network — that is what makes them useful in CI and on a fresh clone.
 *
 * Anything that needs real bindings belongs in an integration test run against
 * `wrangler dev`, not here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: "verbose"
  }
});
