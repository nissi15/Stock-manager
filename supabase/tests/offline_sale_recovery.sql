-- Run after migration 0012. All fixture writes are rolled back.
-- This selects the two newest Auth users. Do not run while either account
-- is actively trading; the test briefly locks and changes an older day row.
begin;

create temp table offline_test_users as
select id, row_number() over (order by created_at desc,id desc)::integer as n
from (select id,created_at from auth.users order by created_at desc,id desc limit 2) users;

create temp table offline_test_fixture (
  n integer primary key, owner_id uuid not null, day_id uuid not null,
  product_id uuid not null, day_date date not null, sale_id uuid not null
);

do $$
declare
  v_n integer;
  v_owner uuid;
  v_product uuid;
  v_day uuid;
  v_date date := (now() at time zone 'Africa/Kigali')::date - 2;
begin
  if (select count(*) from offline_test_users) <> 2 then raise exception 'Two Auth accounts are required'; end if;
  for v_n in 1..2 loop
    select id into strict v_owner from offline_test_users where n = v_n;
    insert into public.products(owner_id,name,category,unit,stock,price)
      values(v_owner,'offline-test-' || gen_random_uuid()::text,'Test','unit',3,100)
      returning id into v_product;
    insert into public.stock_batches(owner_id,product_id,quantity,remaining,unit_cost,supplier,paid)
      values(v_owner,v_product,3,3,40,'Test supplier',120);
    insert into public.business_days(owner_id,date,status,opened_at)
      values(v_owner,v_date,'open',(v_date::timestamp + interval '8 hours') at time zone 'Africa/Kigali')
      on conflict(owner_id,date) do update set status='open',opened_at=excluded.opened_at
      returning id into v_day;
    insert into offline_test_fixture values(v_n,v_owner,v_day,v_product,v_date,gen_random_uuid());
  end loop;
end $$;

grant select on offline_test_users,offline_test_fixture to authenticated;

create function pg_temp.exercise_offline_sale(p_n integer)
returns void language plpgsql security invoker as $$
declare
  v_owner uuid := (select owner_id from offline_test_fixture where n = p_n);
  v_day uuid := (select day_id from offline_test_fixture where n = p_n);
  v_product uuid := (select product_id from offline_test_fixture where n = p_n);
  v_foreign_product uuid := (select product_id from offline_test_fixture where n <> p_n);
  v_foreign_sale uuid := (select sale_id from offline_test_fixture where n <> p_n);
  v_date date := (select day_date from offline_test_fixture where n = p_n);
  v_sold_at timestamptz := (v_date::timestamp + interval '12 hours') at time zone 'Africa/Kigali';
  v_sale uuid := (select sale_id from offline_test_fixture where n = p_n);
begin
  if auth.uid() is distinct from v_owner then raise exception 'Wrong simulated account'; end if;
  perform public.record_offline_sale(v_sale,v_sold_at,v_date,
    jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',2,'unitPrice',100)),
    '[{"method":"cash","amount":200}]'::jsonb);
  if not exists(select 1 from public.sales where id=v_sale and owner_id=v_owner and day_id=v_day and created_at=v_sold_at and total=200 and cost=80)
    then raise exception 'Offline sale was not assigned to its original day'; end if;
  if (select stock from public.products where id=v_product) <> 1 then raise exception 'Stock was not allocated once'; end if;

  perform public.record_offline_sale(v_sale,v_sold_at,v_date,
    jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',2,'unitPrice',100)),
    '[{"method":"cash","amount":200}]'::jsonb);
  if (select stock from public.products where id=v_product) <> 1
    or (select count(*) from public.sales where id=v_sale) <> 1
    then raise exception 'Retry duplicated the sale or stock deduction'; end if;

  begin
    perform public.record_offline_sale(gen_random_uuid(),v_sold_at,v_date,
      jsonb_build_array(jsonb_build_object('productId',v_foreign_product,'quantity',1,'unitPrice',100)),
      '[{"method":"cash","amount":100}]'::jsonb);
    raise exception 'Cross-account product was accepted';
  exception when others then
    if sqlerrm = 'Cross-account product was accepted' then raise; end if;
    if sqlerrm <> 'Product not found' then raise; end if;
  end;

  if p_n = 2 then
    begin
      perform public.record_offline_sale(v_foreign_sale,v_sold_at,v_date,
        jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',1,'unitPrice',100)),
        '[{"method":"cash","amount":100}]'::jsonb);
      raise exception 'Cross-account sale ID was accepted';
    exception when others then
      if sqlerrm = 'Cross-account sale ID was accepted' then raise; end if;
      if sqlerrm <> 'Sale ID belongs to another account' then raise; end if;
    end;
  end if;

  begin
    perform public.record_offline_sale(gen_random_uuid(),v_sold_at,v_date + 1,
      jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',1,'unitPrice',100)),
      '[{"method":"cash","amount":100}]'::jsonb);
    raise exception 'Mismatched day was accepted';
  exception when others then
    if sqlerrm = 'Mismatched day was accepted' then raise; end if;
    if sqlerrm <> 'Offline sale time does not match its business day' then raise; end if;
  end;
end $$;

grant execute on function pg_temp.exercise_offline_sale(integer) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from offline_test_users where n=1),true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.exercise_offline_sale(1);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from offline_test_users where n=2),true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.exercise_offline_sale(2);
reset role;

update public.business_days set status='closed' where id=(select day_id from offline_test_fixture where n=1);
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from offline_test_users where n=1),true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare
  v_product uuid := (select product_id from offline_test_fixture where n=1);
  v_date date := (select day_date from offline_test_fixture where n=1);
  v_existing_sale uuid := (select sale_id from offline_test_fixture where n=1);
begin
  perform public.record_offline_sale(v_existing_sale,(v_date::timestamp + interval '12 hours') at time zone 'Africa/Kigali',v_date,
    jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',2,'unitPrice',100)),
    '[{"method":"cash","amount":200}]'::jsonb);
  if (select count(*) from public.sales where id=v_existing_sale) <> 1
    or (select stock from public.products where id=v_product) <> 1
    then raise exception 'Retry after close duplicated the sale or stock deduction'; end if;
  begin
    perform public.record_offline_sale(gen_random_uuid(),(v_date::timestamp + interval '12 hours') at time zone 'Africa/Kigali',v_date,
      jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',1,'unitPrice',100)),
      '[{"method":"cash","amount":100}]'::jsonb);
    raise exception 'Closed day accepted a late sale';
  exception when others then
    if sqlerrm = 'Closed day accepted a late sale' then raise; end if;
    if sqlerrm not like 'The original business day is closed or missing%' then raise; end if;
  end;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon','public.record_offline_sale(uuid,timestamptz,date,jsonb,jsonb)','EXECUTE')
    then raise exception 'Anonymous role can execute offline sale RPC'; end if;
  if not has_function_privilege('authenticated','public.record_offline_sale(uuid,timestamptz,date,jsonb,jsonb)','EXECUTE')
    then raise exception 'Authenticated role cannot execute offline sale RPC'; end if;
end $$;

rollback;
select 'PASS: offline sale day, retry, owner isolation and grants; all fixtures rolled back' as offline_sale_test_result;
