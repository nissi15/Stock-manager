-- Run all of this file in the Supabase SQL Editor after migration 0010.
-- Uses the two newest Auth users. All changes are rolled back.
-- Run only when neither account is actively using the app: today's day rows
-- are briefly locked. Test accounts must have no uncosted sales today.
begin;

create temp table closing_test_users as
select id, row_number() over (order by created_at desc,id desc)::integer as n
from (select id,created_at from auth.users order by created_at desc,id desc limit 2) u;
create temp table closing_test_fixture (
  n integer primary key, owner_id uuid not null, day_id uuid not null,
  product_id uuid not null, closing_count bigint not null,
  activity_count bigint not null
);

do $$
declare
  v_n integer;
  v_owner uuid;
  v_product uuid;
  v_day uuid;
  v_closings bigint;
  v_activities bigint;
begin
  if (select count(*) from closing_test_users) <> 2 then
    raise exception 'Two Auth accounts are required';
  end if;
  for v_n in 1..2 loop
    select id into strict v_owner from closing_test_users where n = v_n;
    if exists(
      select 1 from public.sales s
      join public.business_days d on d.id = s.day_id
      where s.owner_id = v_owner and s.has_cost_deficit
        and d.date = (now() at time zone 'Africa/Kigali')::date
    ) then
      raise exception 'Account % has uncosted sales today; use clean test accounts',v_n;
    end if;
    insert into public.products(owner_id,name,category,unit,stock,price)
      values(v_owner,'closing-test-' || gen_random_uuid()::text,'Test','unit',0,100)
      returning id into v_product;
    insert into public.business_days(owner_id,date,status)
      values(v_owner,(now() at time zone 'Africa/Kigali')::date,'open')
      on conflict(owner_id,date) do update set status = 'open'
      returning id into v_day;
    select count(*) into v_closings from public.business_day_closings
      where owner_id = v_owner and day_id = v_day;
    select count(*) into v_activities from public.activity_logs where owner_id = v_owner;
    insert into closing_test_fixture values(v_n,v_owner,v_day,v_product,v_closings,v_activities);
  end loop;
end $$;

-- The next statements run as `authenticated`; both temporary lookup tables
-- must remain readable after that role switch.
grant select on closing_test_users, closing_test_fixture to authenticated;

create function pg_temp.exercise_closing(p_n integer)
returns void language plpgsql security invoker as $$
declare
  v_own uuid := (select owner_id from closing_test_fixture where n = p_n);
  v_day uuid := (select day_id from closing_test_fixture where n = p_n);
  v_product uuid := (select product_id from closing_test_fixture where n = p_n);
  v_foreign_product uuid := (select product_id from closing_test_fixture where n <> p_n);
  v_snapshot jsonb;
begin
  if auth.uid() is distinct from v_own then raise exception 'Wrong simulated account'; end if;
  v_snapshot := public.close_business_day(0);
  if not exists(
    select 1 from jsonb_array_elements(v_snapshot->'stockRemaining') as item(value)
      where item.value->>'productId' = v_product::text
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'stockRemaining') as item(value)
      where item.value->>'productId' = v_foreign_product::text
  ) then
    raise exception 'Account % closing snapshot mixed account stock',p_n;
  end if;
  if not exists(select 1 from public.business_day_closings
      where owner_id = v_own and day_id = v_day and snapshot = v_snapshot) then
    raise exception 'Account % cannot read its own closing',p_n;
  end if;
  begin
    insert into public.expenses(owner_id,category,amount,method)
      values(v_own,'Closed-day guard test',1,'cash');
    raise exception 'Account % could write after closing',p_n;
  exception when others then
    if sqlerrm like 'Account % could write after closing' then raise; end if;
    if sqlerrm not like 'Reopen the business day before recording another transaction%'
      then raise;
    end if;
  end;
  perform public.reopen_business_day('Isolation test reopening');
  if not exists(select 1 from public.business_days
      where id = v_day and owner_id = v_own and status = 'open') then
    raise exception 'Account % day did not reopen',p_n;
  end if;
  if not exists(select 1 from public.activity_logs
      where owner_id = v_own and action = 'Day reopened'
        and detail = 'Isolation test reopening') then
    raise exception 'Account % reopening reason was not logged',p_n;
  end if;
end $$;

grant execute on function pg_temp.exercise_closing(integer) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from closing_test_users where n = 1),true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.exercise_closing(1);
reset role;

do $$
begin
  if exists(
    select 1 from closing_test_fixture f
    join public.business_days d on d.id = f.day_id
    where f.n = 2 and d.status <> 'open'
  ) or exists(
    select 1 from closing_test_fixture f
    where f.n = 2 and
      (select count(*) from public.business_day_closings
       where owner_id = f.owner_id and day_id = f.day_id) <> f.closing_count
  ) or exists(
    select 1 from closing_test_fixture f
    where f.n = 2 and
      (select count(*) from public.activity_logs
       where owner_id = f.owner_id) <> f.activity_count
  ) then
    raise exception 'Closing account A changed account B';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from closing_test_users where n = 2),true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.exercise_closing(2);
reset role;

do $$
begin
  if exists(
    select 1 from closing_test_fixture f
    join public.business_days d on d.id = f.day_id
    where d.status <> 'open'
       or (select count(*) from public.business_day_closings
           where owner_id = f.owner_id and day_id = f.day_id) <> f.closing_count + 1
       or (select count(*) from public.activity_logs
           where owner_id = f.owner_id) <> f.activity_count + 2
  ) then
    raise exception 'Closing or reopening crossed account boundaries';
  end if;
end $$;

rollback;
select 'PASS: closing and reopening isolated for both accounts; all changes rolled back'
  as closing_test_result;
