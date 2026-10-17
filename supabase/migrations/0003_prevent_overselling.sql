-- Prevent any workflow, including older RPC versions, from reducing stock below zero.
-- Existing negative balances can still be corrected upward by receiving stock.

create or replace function public.prevent_negative_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stock < 0 and new.stock < old.stock then
    raise exception 'Not enough stock for %', new.name;
  end if;
  return new;
end $$;

drop trigger if exists products_prevent_negative_stock on public.products;
create trigger products_prevent_negative_stock
before update of stock on public.products
for each row execute function public.prevent_negative_stock();

revoke all on function public.prevent_negative_stock() from public;
