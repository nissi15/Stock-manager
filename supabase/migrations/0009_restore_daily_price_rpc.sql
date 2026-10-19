-- Run after 0008_restrict_function_execute.sql.
-- Restore only the missing price-update RPC. Do not rerun 0002: its edit_sale
-- definition predates the FIFO allocation logic installed by 0005.

begin;

create or replace function public.update_daily_prices(p_prices jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_day uuid;
  v_product record;
  v_price bigint;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  select d.id into v_day
    from public.business_days d
    where d.owner_id = v_owner
      and d.date = (now() at time zone 'Africa/Kigali')::date
      and d.status = 'open'
    for update;
  if v_day is null then raise exception 'Open today''s business day first'; end if;

  for v_product in
    select p.id from public.products p where p.owner_id = v_owner and p.active
  loop
    v_price := (p_prices ->> v_product.id::text)::bigint;
    if v_price is null or v_price < 0 then
      raise exception 'Every active product needs a valid price';
    end if;
    insert into public.daily_prices(owner_id,day_id,product_id,price)
      values(v_owner,v_day,v_product.id,v_price)
      on conflict(day_id,product_id) do update set price = excluded.price;
    update public.products
      set price = v_price
      where id = v_product.id and owner_id = v_owner;
  end loop;

  insert into public.activity_logs(owner_id,action,detail)
    values(v_owner,'Daily prices updated',(now() at time zone 'Africa/Kigali')::date::text);
end $$;

revoke execute on function public.update_daily_prices(jsonb) from public, anon;
grant execute on function public.update_daily_prices(jsonb) to authenticated;

commit;

select
  to_regprocedure('public.update_daily_prices(jsonb)') is not null as function_exists,
  has_function_privilege('authenticated','public.update_daily_prices(jsonb)','EXECUTE') as authenticated_can_execute,
  has_function_privilege('anon','public.update_daily_prices(jsonb)','EXECUTE') as anonymous_can_execute;
