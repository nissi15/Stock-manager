-- Run after 0012_offline_sale_recovery.sql. Independent of 0013.
-- Stops a stock receipt or an expense from being saved twice when the app retries after a slow
-- or timed-out connection. The app sends one request id per attempt and reuses it on retry;
-- the database keeps the first copy and treats the repeat as already done.
--
-- Additive only: the existing 6-argument receive_stock and plain expense inserts keep working,
-- so the currently deployed app is unaffected, and the new app falls back to them if this
-- migration has not been run yet.

begin;

alter table public.stock_batches add column if not exists client_request_id uuid;
alter table public.expenses add column if not exists client_request_id uuid;

create unique index if not exists stock_batches_owner_request_key
  on public.stock_batches(owner_id, client_request_id) where client_request_id is not null;
create unique index if not exists expenses_owner_request_key
  on public.expenses(owner_id, client_request_id) where client_request_id is not null;

create or replace function public.receive_stock(p_product_id uuid,p_quantity integer,p_unit_cost bigint,p_supplier text,p_paid bigint,p_note text,p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_name text;
  v_batch_id uuid;
  v_line record;
  v_used integer;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if p_quantity is null or p_quantity <= 0 or p_unit_cost is null or p_unit_cost < 0 or p_paid is null or p_paid < 0 or p_paid > p_quantity::bigint*p_unit_cost then raise exception 'Invalid stock receipt'; end if;
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('receive_stock:' || p_request_id::text, 0));
  end if;
  select name into v_name from products where id = p_product_id and owner_id = v_owner for update;
  if not found then raise exception 'Product not found'; end if;

  -- A retry of a receipt that already went through: nothing more to do.
  if p_request_id is not null and exists(select 1 from stock_batches where owner_id = v_owner and client_request_id = p_request_id) then
    return;
  end if;

  insert into stock_batches(owner_id,product_id,quantity,remaining,unit_cost,supplier,paid,note,client_request_id)
    values(v_owner,p_product_id,p_quantity,p_quantity,p_unit_cost,coalesce(p_supplier,''),p_paid,coalesce(p_note,''),p_request_id)
    returning id into v_batch_id;
  update products set stock = stock + p_quantity where id = p_product_id and owner_id = v_owner;

  for v_line in
    select sl.id,sl.sale_id,sl.cost_deficit
      from sale_lines sl join sales s on s.id = sl.sale_id
      where sl.owner_id = v_owner and sl.product_id = p_product_id and sl.cost_deficit > 0
      order by s.created_at,sl.id for update of sl
  loop
    select least(v_line.cost_deficit,remaining) into v_used from stock_batches where id = v_batch_id;
    exit when v_used <= 0;
    update stock_batches set remaining = remaining - v_used where id = v_batch_id;
    insert into sale_batch_allocations(owner_id,sale_id,sale_line_id,batch_id,quantity,unit_cost)
      values(v_owner,v_line.sale_id,v_line.id,v_batch_id,v_used,p_unit_cost)
      on conflict (sale_line_id,batch_id) do update
        set quantity = sale_batch_allocations.quantity + excluded.quantity;
    update sale_lines set cost_deficit = cost_deficit - v_used,unit_cost = unit_cost + v_used::bigint*p_unit_cost where id = v_line.id;
    update sales set cost = cost + v_used::bigint*p_unit_cost where id = v_line.sale_id;
    update sales set has_cost_deficit = exists(select 1 from sale_lines where sale_id = v_line.sale_id and cost_deficit > 0) where id = v_line.sale_id;
  end loop;

  insert into activity_logs(owner_id,action,detail) values(v_owner,'Stock received',p_quantity::text || ' × ' || v_name);
end $$;

revoke execute on function public.receive_stock(uuid,integer,bigint,text,bigint,text,uuid) from public, anon;
grant execute on function public.receive_stock(uuid,integer,bigint,text,bigint,text,uuid) to authenticated;

commit;

-- Ask PostgREST to pick up the new function and columns straight away.
notify pgrst, 'reload schema';
