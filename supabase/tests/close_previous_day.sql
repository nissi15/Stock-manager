-- Run after migration 0011. The test briefly locks one account's day rows.
-- Run when that account is idle. All fixture changes are rolled back.
begin;

create temp table late_close_test (owner_id uuid, day_id uuid, day_date date);

do $$
declare
  v_owner uuid;
  v_date date := (now() at time zone 'Africa/Kigali')::date - 1;
  v_day uuid;
begin
  select id into v_owner from auth.users order by created_at desc limit 1;
  if v_owner is null then raise exception 'An Auth user is required'; end if;

  -- Temporarily clear another open day so this fixture is the only open one.
  update public.business_days set status = 'closed'
    where owner_id = v_owner and status = 'open';
  while exists(select 1 from public.business_days where owner_id = v_owner and date = v_date) loop
    v_date := v_date - 1;
  end loop;
  insert into public.business_days(owner_id,date,status)
    values(v_owner,v_date,'open') returning id into v_day;
  insert into late_close_test values(v_owner,v_day,v_date);
end $$;

grant select on late_close_test to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select owner_id::text from late_close_test),true);

do $$
declare
  v_day uuid := (select day_id from late_close_test);
  v_date date := (select day_date from late_close_test);
  v_snapshot jsonb;
begin
  v_snapshot := public.close_business_day(0);
  if (v_snapshot->>'date')::date is distinct from v_date then
    raise exception 'Previous-day closing returned the wrong date';
  end if;
  if not exists(select 1 from public.business_days where id = v_day and status = 'closed') then
    raise exception 'Previous day remained open';
  end if;
  if not exists(select 1 from public.business_day_closings where day_id = v_day and snapshot = v_snapshot) then
    raise exception 'Previous-day closing snapshot was not saved';
  end if;
end $$;

reset role;
rollback;
select 'PASS: previous open day closed and snapshot saved; all changes rolled back' as late_close_test_result;
