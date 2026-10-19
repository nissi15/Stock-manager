# Stock Manager

Wholesale point-of-sale and stock workspace built with SvelteKit, TypeScript and Supabase.

## Run locally

```sh
npm install
npm run dev
```

With no environment variables, the app opens in **Demo mode**. It uses browser local storage and a generated seven-day wholesale scenario so the interface can be reviewed without a backend. Demo records are not production accounting data; profit is intentionally withheld as unverified.

If your local `.env` points to Supabase, launch the scenario separately with:

```sh
npm run dev:demo
```

Open `http://localhost:5174/`. This mode ignores Supabase even when credentials are present. It starts with Rice (Tanzanian, Zahabu, Pakistan), Oil (Zahabu, Crystal), Soft drink (Novida, Martin), Salt, and Soap (Jambo, Jama). Every product has costed opening stock. Each of the last seven days has 19–30 mixed sales, stock receipts, and expenses, with Cash, MoMo, Bank, and split payments. Demo edits persist in that browser's local storage; a fresh browser profile starts from the generated scenario again.

## Run tests

```sh
npm test
```

The unit tests exercise the in-memory workflow and verify the generated scenario's daily operation counts, stock reconciliation, costs, and payment totals. Supabase is mocked, so they never read or change the live project. Use `npm run test:watch` while developing. Before shipping changes, run `npm test`, `npm run check`, and `npm run build`.
GitHub Actions runs these checks automatically on pushes and pull requests.

For a database isolation check, create two confirmed test accounts, then run the
entire [extended isolation SQL test](supabase/tests/two_account_isolation_extended.sql)
in the Supabase SQL Editor after migrations 0001-0010. It impersonates each
account, checks both directions across owner-scoped tables and ID-based RPCs,
checks anonymous access, and rolls back all fixtures. Run it when neither test
account is actively selling because it briefly locks their current business-day
rows. A `PASS` result means those assertions ran successfully; it does not
replace browser/API end-to-end testing or a security review of new functions.

To exercise day closing and reopening for both accounts, run the entire
[`day_close_reopen_isolation.sql`](supabase/tests/day_close_reopen_isolation.sql)
in the SQL Editor. It checks the closing snapshot (including account-specific
remaining stock), the reopening reason in Activity, and that neither account's
closing affects the other. It rolls back its fixtures, closings, and log entries.
Run it when neither account is using the app; the test temporarily locks today's
business-day rows. If either account has uncosted sales today, use clean test
accounts instead. After migration 0011, run
[`close_previous_day.sql`](supabase/tests/close_previous_day.sql) to verify that
an overnight-open day can be closed; the test also rolls back all changes.

For a real-Auth-session, read-only check through the Supabase API, put at least
one product in each test account, then run `npm run test:api-isolation` with
`TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, and `TEST_B_PASSWORD` set in
your terminal environment. Do not store these passwords in `.env`, commit them,
or paste them into chat. The script uses independent sessions, checks every
owner-scoped table in both directions, and pages through all visible rows. This
does not test browser rendering, PDF contents, or cross-account writes; the SQL
tests cover the latter.

## Connect Supabase

1. Create a Supabase project and enable email/password authentication.
2. Run the SQL files in `supabase/migrations` in numeric order in the Supabase SQL editor. Existing projects should run each newly added migration once.
3. Copy `.env.example` to `.env` and fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` with the project URL and publishable key. These values identify the browser app and are visible in DevTools; database access is protected by the included owner-scoped RLS policies. **Never put a secret or service-role key in this file.**
4. Restart the dev server, sign up, create products, record opening stock through **Add stock**, and start the day.

The migrations enforce per-user row-level security and use database functions for atomic day opening, stock receipt, FIFO-costed sales, stock-loss adjustments, and day close. Migration `0005_batch_profit_ledger.sql` preserves the exact receipt batch consumed by every new sale or stock loss so realized profit can be reported batch by batch. Migration `0007_day_closing_snapshots.sql` stores an authoritative closing snapshot with cash reconciliation and remaining stock, and blocks new transactions until a closed day is reopened. Migration `0008_restrict_function_execute.sql` removes anonymous execution grants from the business functions. Migration `0009_restore_daily_price_rpc.sql` restores the missing price-update RPC without overwriting newer sale logic; `0010_restore_stock_floor_trigger.sql` restores the negative-stock guard. Migration `0011_close_previous_business_day.sql` lets an account reconcile an older day left open overnight before starting a new one. Historical consumption from before batch tracking is marked as a legacy gap rather than being assigned an invented profit. Sales use client-generated UUIDs for retry idempotency.

## Current scope

- New Sale workspace with search, cart, per-sale price changes, split Cash/MoMo/Bank payment, and drag or keyboard/click confirmation.
- Daily price review and same-day updates, reusable category/measurement suggestions, uniquely referenced FIFO stock receipts with automatic arrival times, oversell prevention, filtered operating-expense history, automatic FIFO-costed stock damage/loss adjustments, clickable sale details with audited same-day corrections, payment totals, and activity timeline.
- CSV export for sales; responsive layout and reduced-motion support.
- IndexedDB queue for sales made while the app remains open and goes offline.

## Important limits before live deployment

This is a working first build, **not yet a production-ready accounting system**. Offline catalog/day restoration after a full reload, reconciliation of pending sales across devices before close, supplier-balance settlement, XLSX exports, receipt printing, and automated database tests remain to be completed. Closing cash reconciliation and PDF exports are implemented, but RLS and database functions still need dedicated integration tests with separate test accounts. Use test data until those checks are complete.

The app uses the `Africa/Kigali` business-day timezone and integer RWF amounts.
