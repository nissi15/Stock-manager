# Stock Manager

Wholesale point-of-sale and stock workspace built with SvelteKit, TypeScript and Supabase.

## Run locally

```sh
npm install
npm run dev
```

With no environment variables, the app opens in **Demo mode**. It uses browser local storage and sample products so the interface can be reviewed without a backend. Demo records are not production accounting data; costs and profit are intentionally unverified.

## Run tests

```sh
npm test
```

The unit tests exercise the in-memory stock and sales workflow with Supabase mocked, so they never read or change the live project. Use `npm run test:watch` while developing. Before shipping changes, run `npm test`, `npm run check`, and `npm run build`.
GitHub Actions runs these checks automatically on pushes and pull requests.

## Connect Supabase

1. Create a Supabase project and enable email/password authentication.
2. Run [`supabase/migrations/0001_initial.sql`](supabase/migrations/0001_initial.sql) in the Supabase SQL editor.
3. Copy `.env.example` to `.env` and fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the project URL and publishable/anon key. **Never put a service-role key in this file.**
4. Restart the dev server, sign up, create products, record opening stock through **Add stock**, and start the day.

The migration enforces per-user row-level security and uses database functions for atomic day opening, stock receipt, FIFO-costed sales, and day close. A stock deficit caused by an oversell is flagged and blocks day close until a later receipt allocates cost to it. Sales use client-generated UUIDs for retry idempotency.

## Current scope

- New Sale workspace with search, cart, per-sale price changes, split Cash/MoMo/Bank payment, and drag or keyboard/click confirmation.
- Daily price review, stock receipts with buying cost and supplier, expenses, sales history, payment totals, and activity timeline.
- CSV export for sales; responsive layout and reduced-motion support.
- IndexedDB queue for sales made while the app remains open and goes offline.

## Important limits before live deployment

This is a working first build, **not yet a production-ready accounting system**. Offline catalog/day restoration after a full reload, reconciliation of pending sales across devices before close, supplier-balance settlement, cash drawer reconciliation, PDF/XLSX exports, receipt printing, and automated database tests remain to be completed. RLS and database functions still need dedicated integration tests with separate test accounts. Use test data until those checks are complete.

The app uses the `Africa/Kigali` business-day timezone and integer RWF amounts.
