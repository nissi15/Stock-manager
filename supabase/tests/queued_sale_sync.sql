-- Run after migration 0012 in the Supabase SQL Editor. It briefly locks one
-- account's business-day rows, so run it while that account is idle.
-- All fixture changes are rolled back.
begin;

create temp table queued_sale_test (
  owner_id uuid, today_id uuid, today_date date, today_start timestamptz,
  yesterday_date date, product_id uuid
);

do $$
declare
  v_owner uuid;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz := (v_today::timestamp at time zone 'Africa/Kigali');
  v_today_id uuid;
  v_product uuid;
begin
  select id into v_owner from auth.users order by created_at desc limit 1;
  if v_owner is null then raise exception 'An Auth user is required'; end if;

  update public.business_days set status = 'closed' where owner_id = v_owner and status = 'open';
  insert into public.business_days(owner_id,date,status,opened_at)
    values(v_owner,v_today,'open',v_start)
    on conflict(owner_id,date) do update set status = 'open',opened_at = v_start
    returning id into v_today_id;
  insert into public.business_days(owner_id,date,status)
    values(v_owner,v_today - 1,'closed')
    on conflict(owner_id,date) do update set status = 'closed';

  insert into public.products(owner_id,name,category,unit,stock,price,active)
    values(v_owner,'Queued sale test ' || gen_random_uuid(),'Test','unit',10,100,true)
    returning id into v_product;
  insert into public.stock_batches(owner_id,product_id,quantity,remaining,unit_cost)
    values(v_owner,v_product,10,10,60);

  insert into queued_sale_test values(v_owner,v_today_id,v_today,v_start,v_today - 1,v_product);
end $$;

grant select on queued_sale_test to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select owner_id::text from queued_sale_test),true);

do $$
declare
  t queued_sale_test%rowtype;
  v_sold timestamptz;
  v_sale uuid := gen_random_uuid();
  v_future uuid := gen_random_uuid();
  v_late uuid := gen_random_uuid();
  v_lines jsonb;
  v_rejected boolean := false;
begin
  select * into t from queued_sale_test;
  v_lines := jsonb_build_array(jsonb_build_object('productId',t.product_id,'quantity',1,'unitPrice',100));
  v_sold := greatest(now() - interval '1 minute',t.today_start);

  -- 1. A queued sale keeps the time it was made and joins that day's totals.
  perform public.record_sale(v_sale,v_lines,'[{"method":"cash","amount":100}]'::jsonb,v_sold);
  if not exists(select 1 from public.sales where id = v_sale and day_id = t.today_id and created_at = v_sold) then
    raise exception 'Queued sale did not keep its original time and day';
  end if;

  -- 2. Retrying an already-recorded sale is a no-op, even with a closed-day timestamp.
  perform public.record_sale(v_sale,v_lines,'[{"method":"cash","amount":100}]'::jsonb,t.today_start - interval '12 hours');
  if (select count(*) from public.sales where id = v_sale) <> 1 then raise exception 'Retry duplicated the sale'; end if;
  if (select stock from public.products where id = t.product_id) <> 9 then raise exception 'Retry changed stock'; end if;

  -- 3. A queued sale from a closed day is rejected rather than moved to today.
  begin
    perform public.record_sale(v_late,v_lines,'[{"method":"cash","amount":100}]'::jsonb,t.today_start - interval '12 hours');
  exception when others then
    v_rejected := sqlerrm like 'The business day for this queued sale%';
  end;
  if not v_rejected then raise exception 'Queued sale for a closed day was not rejected'; end if;
  if exists(select 1 from public.sales where id = v_late) then raise exception 'Rejected sale was stored'; end if;

  -- 4. A device clock ahead of the server cannot create a future sale.
  perform public.record_sale(v_future,v_lines,'[{"method":"cash","amount":100}]'::jsonb,now() + interval '3 hours');
  if (select created_at from public.sales where id = v_future) > now() then raise exception 'Future sale time was accepted'; end if;

  -- 5. Normal online sales are unchanged.
  perform public.record_sale(gen_random_uuid(),v_lines,'[{"method":"cash","amount":100}]'::jsonb);
  if (select stock from public.products where id = t.product_id) <> 7 then raise exception 'Online sale did not reduce stock'; end if;
end $$;

reset role;
rollback;
select 'PASS: queued sales keep their time, retries are no-ops, closed days reject late sales; all changes rolled back' as queued_sale_test_result;
