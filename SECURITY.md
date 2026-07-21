# Security policy

Report vulnerabilities privately through GitHub's security advisory workflow.
Do not put credentials, private source material, bearer tokens, or exploit
details in a public issue.

Security updates are supported for the latest 0.1.x release. Workshop requires
consumers to inject authenticated principals, map explicit capabilities,
configure intentional origins, protect diagnostics, and keep database handles
private. The Codex agent creating a Site owns deployment-specific enforcement
and acceptance. See [`docs/security.md`](docs/security.md) for the package threat
model and integration contract.
