-- Run after 0007_day_closing_snapshots.sql.
-- Supabase projects can grant EXECUTE to anon explicitly by default.
-- Revoking from PUBLIC alone (in earlier migrations) does not remove that grant.
-- Existing projects may have schema drift. Apply this to functions that exist,
-- then inspect the result table for missing app functions before going live.

begin;

do $$
declare
  v_signature text;
  v_app_rpc boolean;
begin
  for v_signature,v_app_rpc in
    select * from (values
      ('public.open_business_day(date,jsonb)',true),
      ('public.create_product(text,text,text,bigint)',true),
      ('public.receive_stock(uuid,integer,bigint,text,bigint,text)',true),
      ('public.record_sale(uuid,jsonb,jsonb)',true),
      ('public.edit_sale(uuid,jsonb,jsonb)',true),
      ('public.update_daily_prices(jsonb)',true),
      ('public.record_stock_loss(uuid,integer,text,text)',true),
      ('public.get_stock_batch_report(date,date)',true),
      ('public.close_business_day(bigint)',true),
      ('public.reopen_business_day(text)',true),
      ('public.audit_expense()',false),
      ('public.prevent_negative_stock()',false),
      ('public.reject_write_after_day_close()',false)
    ) as expected(signature,app_rpc)
  loop
    if to_regprocedure(v_signature) is null then
      raise notice 'Missing function: %',v_signature;
      continue;
    end if;
    execute format('revoke execute on function %s from public, anon',v_signature);
    if v_app_rpc then
      execute format('grant execute on function %s to authenticated',v_signature);
    end if;
  end loop;
end $$;

commit;

-- Review the result, especially MISSING rows. Do not run an old migration
-- blindly to fill a gap: it may replace a newer function implementation.
with expected(signature) as (values
  ('public.open_business_day(date,jsonb)'),
  ('public.create_product(text,text,text,bigint)'),
  ('public.receive_stock(uuid,integer,bigint,text,bigint,text)'),
  ('public.record_sale(uuid,jsonb,jsonb)'),
  ('public.edit_sale(uuid,jsonb,jsonb)'),
  ('public.update_daily_prices(jsonb)'),
  ('public.record_stock_loss(uuid,integer,text,text)'),
  ('public.get_stock_batch_report(date,date)'),
  ('public.close_business_day(bigint)'),
  ('public.reopen_business_day(text)')
)
select signature,
  case when to_regprocedure(signature) is null then 'MISSING'
       when has_function_privilege('anon',signature,'EXECUTE') then 'ANON STILL ALLOWED'
       when not has_function_privilege('authenticated',signature,'EXECUTE') then 'AUTHENTICATED DENIED'
       else 'OK' end as status
from expected;
