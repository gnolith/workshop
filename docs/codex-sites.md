# Codex Site consumption boundary

Workshop is ESM for vinext/Vite, React 19, Next.js App Router conventions, and
Cloudflare Workers. It uses Request, Response, streams, AbortSignal, Web Crypto,
TextEncoder, and performance APIs. Server state is D1-authoritative; runtime
migration discovery, filesystem scanning, lifecycle mutation, and Node built-ins
are absent from package runtime exports.

The fixture under `examples/package-runtime-canary` bundles the exact Workshop
package with Wrangler without a Node compatibility flag. Its Diamond, Taproot,
identity, and host services are injected or stubbed. It is a non-deployable,
isolated package-runtime check, not a four-package Site canary.

The Codex agent creating a Site owns assembly of Diamond, Taproot, Waystone, and
Workshop; infrastructure and migration application; host identity, secrets,
and configuration; deployment; live semantic/MCP/browser probes; and final Site
acceptance. Workshop release evidence does not cover those responsibilities.
