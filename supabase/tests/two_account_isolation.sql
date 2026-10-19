-- Run in the Supabase SQL Editor after applying migrations 0001–0007.
-- Uses the two most recently created Auth users. Every fixture is rolled back.
begin;

create temp table isolation_accounts as
select id, row_number() over (order by created_at desc, id desc) as n
from auth.users
order by created_at desc, id desc
limit 2;

do $$ begin
  if (select count(*) from isolation_accounts) <> 2 then
    raise exception 'Create two Auth accounts before running this test';
  end if;
end $$;

create temp table isolation_fixture (kind text primary key, id uuid not null);

insert into public.products (owner_id, name, category, unit, stock, price)
select id, 'isolation-own-' || gen_random_uuid()::text, 'Test', 'unit', 2, 100
from isolation_accounts where n = 1;

insert into isolation_fixture
select 'own_product', p.id from public.products p
join isolation_accounts a on a.id = p.owner_id and a.n = 1
where p.name like 'isolation-own-%' order by p.created_at desc limit 1;

insert into public.products (owner_id, name, category, unit, stock, price)
select id, 'isolation-test-' || gen_random_uuid()::text, 'Test', 'unit', 2, 100
from isolation_accounts where n = 2
returning id;

insert into isolation_fixture
select 'product', p.id from public.products p
join isolation_accounts a on a.id = p.owner_id and a.n = 2
where p.name like 'isolation-test-%' order by p.created_at desc limit 1;

insert into public.business_days (owner_id, date, status)
select id, date '1999-01-01', 'closed' from isolation_accounts where n = 2
on conflict (owner_id, date) do nothing;

insert into isolation_fixture
select 'day', d.id from public.business_days d
join isolation_accounts a on a.id = d.owner_id and a.n = 2
where d.date = date '1999-01-01';

insert into public.stock_batches (owner_id, product_id, quantity, remaining, unit_cost)
select a.id, f.id, 2, 2, 50 from isolation_accounts a
cross join isolation_fixture f where a.n = 2 and f.kind = 'product'
returning id;

insert into public.sales (id, owner_id, day_id, total, cost)
select gen_random_uuid(), a.id, f.id, 100, 50 from isolation_accounts a
cross join isolation_fixture f where a.n = 2 and f.kind = 'day';

insert into isolation_fixture
select 'sale', s.id from public.sales s
join isolation_accounts a on a.id = s.owner_id and a.n = 2
where s.day_id = (select id from isolation_fixture where kind = 'day')
order by s.created_at desc limit 1;

insert into public.expenses (owner_id, category, amount, method)
select id, 'Isolation test', 1, 'cash' from isolation_accounts where n = 2;

insert into public.activity_logs (owner_id, action)
select id, 'Isolation test' from isolation_accounts where n = 2;

-- Exercise the same policies and grants as a signed-in account A.
grant select on isolation_accounts, isolation_fixture to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from isolation_accounts where n = 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare v_other uuid := (select id from isolation_accounts where n = 2);
        v_product uuid := (select id from isolation_fixture where kind = 'product');
        v_own_product uuid := (select id from isolation_fixture where kind = 'own_product');
        v_sale uuid := (select id from isolation_fixture where kind = 'sale');
        v_table text;
        v_count bigint;
begin
  if not exists(select 1 from public.products where id = v_own_product) then
    raise exception 'Account A cannot see its own product';
  end if;
  foreach v_table in array array[
    'products', 'business_days', 'daily_prices', 'stock_batches',
    'sales', 'sale_lines', 'payments', 'expenses', 'activity_logs',
    'stock_losses', 'sale_batch_allocations', 'stock_loss_batch_allocations',
    'business_day_closings'
  ] loop
    execute format('select count(*) from public.%I where owner_id = $1', v_table)
      into v_count using v_other;
    if v_count <> 0 then raise exception 'Account A can read account B table %', v_table; end if;
  end loop;

  begin
    insert into public.expenses(owner_id, category, amount, method)
    values(v_other, 'Forbidden', 1, 'cash');
    raise exception 'Account A inserted an expense for B';
  exception when insufficient_privilege or check_violation then null;
  end;

  begin
    perform public.receive_stock(v_product, 1, 1, 'Test', 0, '');
    raise exception 'Account A received B stock';
  exception when others then
    if sqlerrm = 'Account A received B stock' then raise; end if;
  end;

  begin
    perform public.record_stock_loss(v_product, 1, 'Damaged', 'Test');
    raise exception 'Account A damaged B stock';
  exception when others then
    if sqlerrm = 'Account A damaged B stock' then raise; end if;
  end;

  begin
    perform public.edit_sale(v_sale, '[]'::jsonb, '[]'::jsonb);
    raise exception 'Account A edited B sale';
  exception when others then
    if sqlerrm = 'Account A edited B sale' then raise; end if;
  end;

  if exists(select 1 from public.get_stock_batch_report(null, null) where product_id = v_product) then
    raise exception 'Account A can report B stock';
  end if;
end $$;

reset role;
rollback;
select 'PASS: account isolation checks completed; test fixtures rolled back' as isolation_test_result;
