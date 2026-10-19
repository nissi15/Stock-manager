-- Run after 0009_restore_daily_price_rpc.sql.
-- Restore the stock-floor guard without replacing any sale or FIFO function.

begin;

create or replace function public.prevent_negative_stock()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.stock < 0 and new.stock < old.stock then
    raise exception 'Not enough stock for %',new.name;
  end if;
  return new;
end $$;

drop trigger if exists products_prevent_negative_stock on public.products;
create trigger products_prevent_negative_stock
  before update of stock on public.products
  for each row execute function public.prevent_negative_stock();

revoke execute on function public.prevent_negative_stock() from public, anon;

commit;

-- Check all three database safety/audit helpers, not just this one.
with expected(signature,table_name,trigger_name) as (values
  ('public.audit_expense()','expenses','expense_audit'),
  ('public.prevent_negative_stock()','products','products_prevent_negative_stock'),
  ('public.reject_write_after_day_close()','expenses','expenses_closed_day_guard'),
  ('public.reject_write_after_day_close()','stock_batches','stock_batches_closed_day_guard'),
  ('public.reject_write_after_day_close()','stock_losses','stock_losses_closed_day_guard')
)
select signature,table_name,trigger_name,
  to_regprocedure(signature) is not null as function_exists,
  exists(
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = table_name
      and t.tgname = trigger_name and t.tgenabled in ('O','A')
      and t.tgfoid = to_regprocedure(signature)
  ) as trigger_active
from expected;
