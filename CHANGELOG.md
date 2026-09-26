# Changelog

## 2026-09-26 — README translated and reviewed

**Moved and translated**
- Moved the README from `docs/README.md` to the repository root, so GitHub shows it on the repo page and the relative links to the ADRs work (from `docs/` they resolved to `docs/docs/adr/...` and were broken).
- Translated the README from Portuguese to English. The other files in `docs/` are still in Portuguese.
- Added technology badges at the top.
- Changed the tagline from "senior-level portfolio project" to a neutral description.
- Fixed the clone URL (`seu-usuario` → `Vitorfarani`).

**Items not implemented yet: moved to a new "Roadmap" section**

These were described as if they already existed. They were not deleted: they now live in the README's Roadmap section as planned work.
- Next.js reconciliation dashboard on `localhost:3001` (removed from the "services" table; kept in the stack table marked *in progress*).
- The word "dashboard" at the end of the E2E flow (`checkout → webhook → ledger → dashboard`).
- Bull Board on `localhost:3000/queues` (removed from the "services" table).
- Pre-built Grafana dashboard (only the Prometheus datasource is provisioned today).
- JWT refresh token rotation (Security now says "JWT").
- Per-IP rate limiting (Security now says "per `merchant_id`", which is what `RateLimitMiddleware` does).
- `docs/adr/README.md`, `ADR-000-template.md`, and the `ledger-discrepancy.md` and `webhook-failures.md` runbooks (removed from the documentation tree because the files don't exist yet).

**Small clarifications**
- API row in the services table: noted it starts with `npm run dev`, not with `docker compose up`.
- Added `Asaas` to the infrastructure layer description, since `AsaasAdapter` exists alongside Stripe.

No code was changed.
