# Security Policy

## Supported Versions

LiteEditorAI is currently in **alpha** (`v1.x`, Linux x64). Security fixes are shipped on the latest release.

| Version | Supported |
|---|---|
| Latest release (`v1.1.x`) | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please **do not open public GitHub issues** for suspected security vulnerabilities, credential leaks, or sandbox/policy bypasses.

Instead, report them confidentially via:
- [GitHub Security Advisories](https://github.com/DanielLetto2020/LiteEditorAI/security/advisories/new)
- Email: `i@m-letto.ru`

Include:
1. A clear description of the issue and potential impact.
2. Minimal reproduction steps or proof-of-concept.
3. Version (`package.json` / *About*), Linux distribution, and affected module.

## Built-in Privacy & Zero-Trust Controls

LiteEditorAI is local-first and does not include telemetry, accounts, or cloud sync:
- **Zero-Trust MCP Hub (`lib/mcp/`):**
  - Per-project policies (`Strict`, `Allow all non-prod DBs & local containers (read-only)`, `Custom`).
  - Session-scoped cryptographic tokens injected per PTY (`LITEEDITOR_MCP_TOKEN`) over local Unix socket (`~/.LiteEditorAI/run/mcp.sock`, verified with `crypto.timingSafeEqual`).
  - `noCloud` database guard blocks row/data egress to cloud CLI models (`claude`, `agy`, `codex`, `gemini`, `openrouter`).
  - Human-in-the-loop (HITL) approvals for unbound resources, production targets (`isProd`), and write/exec operations.
  - Response redaction and audit log sanitization (passwords, tokens, private keys, URI credentials, BiDi/ANSI sequences).
- **Secrets isolation (`lib/store.js`):** Credential and policy keys (`MAIN_ONLY_KEYS`) stay in the Electron main process, encrypted with OS `safeStorage` where supported, and are never exposed in full to renderer bundles.
- **SQL & SSH safety:** AST-based read-only SQL validation (`lib/sqlro.js`) and SSH host-key verification (`lib/hostkeys.js`, TOFU against `~/.ssh/known_hosts`).
- **KeePass vault:** `.kdbx` vaults are decrypted strictly locally with automatic 20-second clipboard clearing.
