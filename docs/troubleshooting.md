# Troubleshooting

- `schema` health false: materialize/apply the migration manifest; runtime does
  not create tables. Compare admin diagnostics with the manifest.
- task creation rejects a query: inspect structured `queryIndex`/`label`, use
  `validate_sparql`, then `dry_run_sparql`; remove updates or unapproved SERVICE.
- claim returns conflict: another caller won, or the task is completed/archived.
- task update returns conflict: reload and use the latest `updatedAt`.
- knowledge write returns conflict: reload canonical entity JSON and use the
  latest Taproot revision.
- MCP returns 406: POST clients must accept JSON and event-stream.
- MCP returns 401/403: configure machine authentication and capabilities; task
  role labels do not help.
- browser call is blocked: same-origin is default; configure one intentional
  allowed origin in the runtime.
- Worker bundle imports Node: confirm the consumer imports the correct explicit
  subpath and does not pull test/release scripts into runtime code.
