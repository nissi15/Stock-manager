-- Run ALL of this file in the Supabase SQL Editor after migrations 0001-0010.
-- Uses the two newest Auth users. No passwords or REST URLs are needed.
-- All test rows and attempted changes are rolled back.
-- Run while neither account is actively selling: this briefly locks today's
-- business-day rows for the two accounts.
begin;

create temp table isolation_users as
select id, row_number() over (order by created_at desc, id desc)::integer as n
from (select id, created_at from auth.users order by created_at desc, id desc limit 2) u;

do $$
begin
  if (select count(*) from isolation_users) <> 2 then
    raise exception 'Two Auth accounts are required';
  end if;
end $$;

create temp table isolation_rows (
  n integer not null,
  kind text not null,
  id uuid not null,
  primary key(n,kind)
);

-- Make every table nonempty for each account, so an empty-table result
-- cannot accidentally pass a read-isolation check.
do $$
declare
  v_n integer;
  v_owner uuid;
  v_product uuid;
  v_day uuid;
  v_batch uuid;
  v_sale uuid;
  v_line uuid;
  v_loss uuid;
  v_id uuid;
begin
  for v_n in 1..2 loop
    select id into strict v_owner from isolation_users where n = v_n;
    insert into public.products(owner_id,name,category,unit,stock,price)
      values(v_owner,'isolation-' || gen_random_uuid()::text,'Test','unit',2,100)
      returning id into v_product;
    insert into isolation_rows values(v_n,'products',v_product);

    insert into public.business_days(owner_id,date,status)
      values(v_owner,date '1700-01-01','closed') returning id into v_day;
    insert into isolation_rows values(v_n,'business_days',v_day);
    insert into public.daily_prices(owner_id,day_id,product_id,price)
      values(v_owner,v_day,v_product,100);

    insert into public.stock_batches(owner_id,product_id,quantity,remaining,unit_cost)
      values(v_owner,v_product,3,1,50) returning id into v_batch;
    insert into isolation_rows values(v_n,'stock_batches',v_batch);

    v_sale := gen_random_uuid();
    insert into public.sales(id,owner_id,day_id,total,cost)
      values(v_sale,v_owner,v_day,100,50);
    insert into isolation_rows values(v_n,'sales',v_sale);
    insert into public.sale_lines(owner_id,sale_id,product_id,product_name,quantity,unit_price,unit_cost)
      values(v_owner,v_sale,v_product,'Isolation product',1,100,50)
      returning id into v_line;
    insert into isolation_rows values(v_n,'sale_lines',v_line);
    insert into public.payments(owner_id,sale_id,method,amount)
      values(v_owner,v_sale,'cash',100) returning id into v_id;
    insert into isolation_rows values(v_n,'payments',v_id);
    insert into public.sale_batch_allocations(owner_id,sale_id,sale_line_id,batch_id,quantity,unit_cost)
      values(v_owner,v_sale,v_line,v_batch,1,50) returning id into v_id;
    insert into isolation_rows values(v_n,'sale_batch_allocations',v_id);

    insert into public.stock_losses(owner_id,product_id,quantity,cost,reason)
      values(v_owner,v_product,1,50,'Damaged') returning id into v_loss;
    insert into isolation_rows values(v_n,'stock_losses',v_loss);
    insert into public.stock_loss_batch_allocations(owner_id,loss_id,batch_id,quantity,unit_cost)
      values(v_owner,v_loss,v_batch,1,50) returning id into v_id;
    insert into isolation_rows values(v_n,'stock_loss_batch_allocations',v_id);

    insert into public.expenses(owner_id,category,amount,method)
      values(v_owner,'Isolation test',1,'cash') returning id into v_id;
    insert into isolation_rows values(v_n,'expenses',v_id);
    insert into public.activity_logs(owner_id,action)
      values(v_owner,'Isolation test') returning id into v_id;
    insert into isolation_rows values(v_n,'activity_logs',v_id);
    insert into public.business_day_closings(owner_id,day_id,counted_cash,expected_cash,cash_difference,snapshot)
      values(v_owner,v_day,100,100,0,'{}'::jsonb) returning id into v_id;
    insert into isolation_rows values(v_n,'business_day_closings',v_id);

    -- Required so record_sale reaches its product-ownership check.
    insert into public.business_days(owner_id,date,status)
      values(v_owner,(now() at time zone 'Africa/Kigali')::date,'open')
      on conflict(owner_id,date) do update set status = 'open';
  end loop;
end $$;

grant select on isolation_users, isolation_rows to authenticated;

-- SECURITY INVOKER is essential: these queries must run under the simulated
-- signed-in role, never with the SQL Editor's privileged permissions.
create function pg_temp.assert_isolation(p_n integer)
returns void language plpgsql security invoker as $$
declare
  v_own uuid := (select id from isolation_users where n = p_n);
  v_other uuid := (select id from isolation_users where n <> p_n);
  v_table text;
  v_count bigint;
  v_foreign_product uuid := (select id from isolation_rows where n <> p_n and kind = 'products');
  v_foreign_sale uuid := (select id from isolation_rows where n <> p_n and kind = 'sales');
  v_foreign_expense uuid := (select id from isolation_rows where n <> p_n and kind = 'expenses');
  v_prices jsonb;
begin
  if auth.uid() is distinct from v_own then
    raise exception 'Simulated account % has the wrong JWT identity',p_n;
  end if;
  foreach v_table in array array[
    'products','business_days','stock_batches','sales','sale_lines','payments',
    'expenses','activity_logs','stock_losses','sale_batch_allocations',
    'stock_loss_batch_allocations','business_day_closings'
  ] loop
    execute format('select count(*) from public.%I where id = $1 and owner_id = $2',v_table)
      into v_count using (select id from isolation_rows where n = p_n and kind = v_table),v_own;
    if v_count <> 1 then
      raise exception 'Account % cannot read its own % fixture',p_n,v_table;
    end if;
    execute format('select count(*) from public.%I where owner_id = $1',v_table)
      into v_count using v_other;
    if v_count <> 0 then
      raise exception 'Account % can read the other account''s %',p_n,v_table;
    end if;
  end loop;

  if not exists(select 1 from public.daily_prices
      where owner_id = v_own
        and product_id = (select id from isolation_rows where n = p_n and kind = 'products'))
    or exists(select 1 from public.daily_prices where owner_id = v_other) then
    raise exception 'Account % daily_prices isolation failed',p_n;
  end if;
  if not exists(select 1 from public.get_stock_batch_report(null,null)
      where product_id = (select id from isolation_rows where n = p_n and kind = 'products'))
    or exists(select 1 from public.get_stock_batch_report(null,null)
      where product_id = v_foreign_product) then
    raise exception 'Account % batch-report isolation failed',p_n;
  end if;

  begin
    insert into public.expenses(owner_id,category,amount,method)
      values(v_other,'Forbidden',1,'cash');
    raise exception 'Foreign expense insert succeeded';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    update public.expenses set category = 'Forbidden' where id = v_foreign_expense;
    get diagnostics v_count = row_count;
    if v_count <> 0 then raise exception 'Foreign expense update succeeded'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.expenses where id = v_foreign_expense;
    get diagnostics v_count = row_count;
    if v_count <> 0 then raise exception 'Foreign expense delete succeeded'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.receive_stock(v_foreign_product,1,50,'Test',0,'');
    raise exception 'Foreign stock receipt succeeded';
  exception when others then
    if sqlerrm <> 'Product not found' then raise; end if;
  end;
  begin
    perform public.record_stock_loss(v_foreign_product,1,'Damaged','Test');
    raise exception 'Foreign stock loss succeeded';
  exception when others then
    if sqlerrm <> 'Product not found' then raise; end if;
  end;
  begin
    perform public.record_sale(gen_random_uuid(),
      jsonb_build_array(jsonb_build_object('productId',v_foreign_product,'quantity',1,'unitPrice',100)),
      '[{"method":"cash","amount":100}]'::jsonb);
    raise exception 'Foreign product sale succeeded';
  exception when others then
    if sqlerrm <> 'Product not found' then raise; end if;
  end;
  begin
    perform public.edit_sale(v_foreign_sale,
      jsonb_build_array(jsonb_build_object('productId',v_foreign_product,'quantity',1,'unitPrice',100)),
      '[{"method":"cash","amount":100}]'::jsonb);
    raise exception 'Foreign sale edit succeeded';
  exception when others then
    if sqlerrm <> 'Only sales from the open business day can be edited' then raise; end if;
  end;

  -- A foreign product ID in the JSON must not change its price.
  select coalesce(jsonb_object_agg(id::text,price),'{}'::jsonb)
    into v_prices from public.products where owner_id = v_own and active;
  perform public.update_daily_prices(
    v_prices || jsonb_build_object(v_foreign_product::text,999999));
end $$;

grant execute on function pg_temp.assert_isolation(integer) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from isolation_users where n = 1),true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.assert_isolation(1);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from isolation_users where n = 2),true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.assert_isolation(2);
reset role;

do $$
begin
  if exists(
    select 1 from public.products p
    join isolation_rows f on f.id = p.id and f.kind = 'products'
    where p.price <> 100
  ) then
    raise exception 'A price update changed another account''s product';
  end if;
  begin
    update public.products set stock = -1
      where id = (select id from isolation_rows where n = 1 and kind = 'products');
    raise exception 'Negative stock update was accepted';
  exception when others then
    if sqlerrm not like 'Not enough stock for %' then raise; end if;
  end;
end $$;

-- The anonymous role must have no business RPC execution grants.
do $$
declare v_function text;
begin
  foreach v_function in array array[
    'public.open_business_day(date,jsonb)',
    'public.create_product(text,text,text,bigint)',
    'public.receive_stock(uuid,integer,bigint,text,bigint,text)',
    'public.record_sale(uuid,jsonb,jsonb)',
    'public.edit_sale(uuid,jsonb,jsonb)',
    'public.update_daily_prices(jsonb)',
    'public.record_stock_loss(uuid,integer,text,text)',
    'public.get_stock_batch_report(date,date)',
    'public.close_business_day(bigint)',
    'public.reopen_business_day(text)',
    'public.audit_expense()',
    'public.prevent_negative_stock()',
    'public.reject_write_after_day_close()'
  ] loop
    if to_regprocedure(v_function) is null then
      raise exception 'Required function is missing: %',v_function;
    end if;
    if has_function_privilege('anon',v_function,'EXECUTE') then
      raise exception 'Anonymous role can execute %',v_function;
    end if;
    if v_function not in (
      'public.audit_expense()',
      'public.prevent_negative_stock()',
      'public.reject_write_after_day_close()'
    ) and not has_function_privilege('authenticated',v_function,'EXECUTE') then
      raise exception 'Signed-in role cannot execute %',v_function;
    end if;
  end loop;
end $$;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','anon',true);
do $$
declare v_table text; v_count bigint;
begin
  foreach v_table in array array[
    'products','business_days','daily_prices','stock_batches','sales','sale_lines',
    'payments','expenses','activity_logs','stock_losses','sale_batch_allocations',
    'stock_loss_batch_allocations','business_day_closings'
  ] loop
    if has_table_privilege('anon',format('public.%I',v_table),'SELECT') then
      execute format('select count(*) from public.%I',v_table) into v_count;
      if v_count <> 0 then raise exception 'Anonymous role can read %',v_table; end if;
    end if;
  end loop;
end $$;
reset role;

rollback;
select 'PASS: both accounts isolated; anonymous access blocked; all test rows rolled back'
  as isolation_test_result;
