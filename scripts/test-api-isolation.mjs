// Read-only check using two real Supabase Auth sessions. Passwords come from
// process environment only; never commit them or put them in VITE_ variables.
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from 'vite';

const config = loadEnv('development', process.cwd(), 'VITE_');
const url = config.VITE_SUPABASE_URL;
const key = config.VITE_SUPABASE_PUBLISHABLE_KEY || config.VITE_SUPABASE_ANON_KEY;
const accounts = [
  { email: process.env.TEST_A_EMAIL, password: process.env.TEST_A_PASSWORD },
  { email: process.env.TEST_B_EMAIL, password: process.env.TEST_B_PASSWORD }
];
const tables = [
  'products', 'business_days', 'daily_prices', 'stock_batches', 'sales',
  'sale_lines', 'payments', 'expenses', 'activity_logs', 'stock_losses',
  'sale_batch_allocations', 'stock_loss_batch_allocations',
  'business_day_closings'
];

if (!url || !key || accounts.some(({ email, password }) => !email || !password)) {
  console.error('Set both TEST_A/TEST_B email and password variables; Supabase URL and publishable key must be in .env.');
  process.exit(1);
}

const clients = accounts.map(() => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
}));

async function checkTable(client, table, ownId, otherId) {
  const pageSize = 500;
  let total = 0;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from(table)
      .select('owner_id').range(offset, offset + pageSize - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    if (data.some((row) => row.owner_id !== ownId)) {
      throw new Error(`${table} exposed another account's row`);
    }
    total += data.length;
    if (data.length < pageSize) break;
  }
  const { count, error } = await client.from(table)
    .select('owner_id', { count: 'exact', head: true })
    .eq('owner_id', otherId);
  if (error) throw new Error(`${table} foreign-owner query failed: ${error.message}`);
  if (count !== 0) throw new Error(`${table} exposed ${count} foreign-owned rows`);
  return total;
}

try {
  const sessions = await Promise.all(clients.map(async (client, i) => {
    const { data, error } = await client.auth.signInWithPassword(accounts[i]);
    if (error || !data.user) throw new Error(`Account ${i + 1} sign-in failed: ${error?.message || 'No user'}`);
    return data.user;
  }));
  if (sessions[0].id === sessions[1].id) throw new Error('Both credentials signed in to the same account');

  const counts = [];
  for (let i = 0; i < 2; i++) {
    const own = sessions[i].id;
    const other = sessions[1 - i].id;
    const perTable = {};
    for (const table of tables) {
      perTable[table] = await checkTable(clients[i], table, own, other);
    }
    if (perTable.products === 0) {
      throw new Error(`Account ${i + 1} needs at least one product before this read test is conclusive`);
    }
    counts.push(perTable);
  }
  console.log('PASS: two independent Auth sessions saw only their own rows.');
  console.log('Table'.padEnd(32) + 'Account 1'.padStart(12) + 'Account 2'.padStart(12));
  for (const table of tables) {
    console.log(table.padEnd(32) + String(counts[0][table]).padStart(12) + String(counts[1][table]).padStart(12));
  }
  const emptyTables = tables.filter((table) => counts.some((count) => count[table] === 0));
  if (emptyTables.length) {
    console.log(`LIMITED COVERAGE: At least one account has no rows in: ${emptyTables.join(', ')}.`);
    console.log('The SQL fixture test covers those tables; add real test data to both accounts for full API coverage.');
  }
  console.log('This checks real API reads, not browser rendering, PDF content, or cross-account writes.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map((client) => client.auth.signOut({ scope: 'local' })));
}
