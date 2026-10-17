-- Run after 0003_prevent_overselling.sql.
-- Records damaged, expired, stolen or missing stock at its exact FIFO cost.

create table if not exists public.stock_losses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  product_id uuid not null references public.products(id),
  created_at timestamptz not null default now(),
  quantity integer not null check (quantity > 0),
  cost bigint not null check (cost >= 0),
  reason text not null check (reason in ('Damaged','Expired','Stolen','Missing','Other')),
  note text not null default ''
);

alter table public.stock_losses enable row level security;
drop policy if exists stock_losses_owner on public.stock_losses;
create policy stock_losses_owner on public.stock_losses
  for select to authenticated using (owner_id = auth.uid());

revoke insert, update, delete on public.stock_losses from authenticated;
grant select on public.stock_losses to authenticated;

create or replace function public.record_stock_loss(
  p_product_id uuid,
  p_quantity integer,
  p_reason text,
  p_note text
)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_product record;
  v_batch record;
  v_needed integer;
  v_used integer;
  v_cost bigint := 0;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_reason not in ('Damaged','Expired','Stolen','Missing','Other') then raise exception 'Invalid stock loss reason'; end if;

  select id,name,unit,stock into v_product
    from products
    where id = p_product_id and owner_id = v_owner and active
    for update;
  if not found then raise exception 'Product not found'; end if;
  if v_product.stock < p_quantity then
    raise exception 'Only % % available', v_product.stock, v_product.unit;
  end if;

  v_needed := p_quantity;
  for v_batch in
    select id,remaining,unit_cost
      from stock_batches
      where owner_id = v_owner and product_id = p_product_id and remaining > 0
      order by received_at,id
      for update
  loop
    exit when v_needed = 0;
    v_used := least(v_needed,v_batch.remaining);
    update stock_batches set remaining = remaining - v_used where id = v_batch.id;
    v_cost := v_cost + v_used::bigint * v_batch.unit_cost;
    v_needed := v_needed - v_used;
  end loop;

  if v_needed > 0 then raise exception 'Missing purchase cost for %', v_product.name; end if;

  update products set stock = stock - p_quantity where id = p_product_id and owner_id = v_owner;
  insert into stock_losses(owner_id,product_id,quantity,cost,reason,note)
    values(v_owner,p_product_id,p_quantity,v_cost,p_reason,trim(coalesce(p_note,'')));
  insert into activity_logs(owner_id,action,detail)
    values(v_owner,'Stock loss recorded',p_quantity::text || ' × ' || v_product.name || ' · ' || p_reason || ' · RWF ' || v_cost::text);
  return v_cost;
end $$;

revoke all on function public.record_stock_loss(uuid,integer,text,text) from public;
grant execute on function public.record_stock_loss(uuid,integer,text,text) to authenticated;
