# Codex Sites compatibility

Workshop is ESM for vinext/Vite, React 19, Next.js App Router conventions, and
Cloudflare Workers. It uses Request, Response, streams, AbortSignal, Web Crypto,
TextEncoder, and performance APIs. Server state is D1-authoritative; runtime
migration discovery, filesystem scanning, lifecycle mutation, and Node built-ins
are absent from package runtime exports.

The canary under `examples/codex-site-canary` bundles with Wrangler without a
Node compatibility flag. A production generated Site must additionally provide
managed D1/R2, apply Diamond/Taproot/Workshop migrations, construct real Diamond
and Taproot services, register Workshop routes/UI, deploy with vinext/Vite, and
run the semantic/MCP/browser gates described in `verification.md`.
