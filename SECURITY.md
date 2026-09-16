# Security

## Supported version

Only the latest commit is supported.

## Deployment requirements

- Never commit provider keys, Supabase service-role keys, Skill IDs or project refs.
- Keep `key_manager` unavailable to `anon` and `authenticated`.
- Do not expose the RPC functions that return credentials to public roles.
- Deploy the Edge Function with `verify_jwt=false` only because it performs Amazon request verification itself.
- Preserve certificate URL validation, certificate-chain verification, timestamp tolerance, Skill ID validation and replay protection.
- Keep the URL allowlist/SSRF protection around scraping tools.
- Require explicit user confirmation before adding tools that execute external actions.

## Credential storage

The included migrations store provider credentials in a backend-only table. This is convenient for rotation but increases database impact if the service-role credential is compromised. For higher-security deployments, replace the plaintext column with Supabase Vault or an external secrets manager.

## Reporting a vulnerability

Open a GitHub security advisory instead of publishing credentials or exploit details in a public issue.
