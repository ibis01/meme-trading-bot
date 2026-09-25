# Meme Trading Bot

Secure, deterministic Solana memecoin trading bot.

## Status
- [ ] Task 001: Repository Audit
- [ ] Task 002: Scaffolding & Config
- [ ] Task 003: Risk Engine
- [ ] Task 004: Token Security
- [ ] Task 005: Strategy Engine
- [ ] Task 006: Execution Layer

## Rules
See `QWEN.md` for the full constitution.

## Continuous Integration

Every push to `main` runs the following via GitHub Actions
(`.github/workflows/ci.yml`):

1. `npm run typecheck`
2. `npm run lint`
3. `npm test` (unit + regression)
4. `npm run test:integration` (against Postgres + Redis services)

Integration tests run against a `meme_bot_test` database created by
`npm run db:create:test`. They are isolated from dev data.
