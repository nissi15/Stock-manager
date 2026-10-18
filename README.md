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

## Connect Supabase

1. Create a Supabase project and enable email/password authentication.
2. Run the SQL files in `supabase/migrations` in numeric order in the Supabase SQL editor. Existing projects should run each newly added migration once.
3. Copy `.env.example` to `.env` and fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the project URL and publishable/anon key. **Never put a service-role key in this file.**
4. Restart the dev server, sign up, create products, record opening stock through **Add stock**, and start the day.

The migrations enforce per-user row-level security and use database functions for atomic day opening, stock receipt, FIFO-costed sales, stock-loss adjustments, and day close. Migration `0005_batch_profit_ledger.sql` preserves the exact receipt batch consumed by every new sale or stock loss so realized profit can be reported batch by batch. Historical consumption from before that migration is marked as a legacy gap rather than being assigned an invented profit. Sales use client-generated UUIDs for retry idempotency.

## Current scope

- New Sale workspace with search, cart, per-sale price changes, split Cash/MoMo/Bank payment, and drag or keyboard/click confirmation.
- Daily price review and same-day updates, reusable category/measurement suggestions, uniquely referenced FIFO stock receipts with automatic arrival times, oversell prevention, filtered operating-expense history, automatic FIFO-costed stock damage/loss adjustments, clickable sale details with audited same-day corrections, payment totals, and activity timeline.
- CSV export for sales; responsive layout and reduced-motion support.
- IndexedDB queue for sales made while the app remains open and goes offline.

## Important limits before live deployment

This is a working first build, **not yet a production-ready accounting system**. Offline catalog/day restoration after a full reload, reconciliation of pending sales across devices before close, supplier-balance settlement, cash drawer reconciliation, PDF/XLSX exports, receipt printing, and automated database tests remain to be completed. RLS and database functions still need dedicated integration tests with separate test accounts. Use test data until those checks are complete.

The app uses the `Africa/Kigali` business-day timezone and integer RWF amounts.
