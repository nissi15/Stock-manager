-- Run after 0004_stock_losses.sql.
-- Persists the exact FIFO batch used by every new sale and stock loss.
-- Historical sales created before this migration remain legacy/unallocated because
-- their original batch links cannot be reconstructed safely from aggregate costs.

create table if not exists public.sale_batch_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  sale_id uuid not null references public.sales(id),
  sale_line_id uuid not null references public.sale_lines(id),
  batch_id uuid not null references public.stock_batches(id),
  quantity integer not null check (quantity > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  unique (sale_line_id,batch_id)
);

create table if not exists public.stock_loss_batch_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  loss_id uuid not null references public.stock_losses(id),
  batch_id uuid not null references public.stock_batches(id),
  quantity integer not null check (quantity > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  unique (loss_id,batch_id)
);

create index if not exists sale_batch_allocations_batch_idx on public.sale_batch_allocations(batch_id);
create index if not exists sale_batch_allocations_sale_idx on public.sale_batch_allocations(sale_id);
create index if not exists stock_loss_batch_allocations_batch_idx on public.stock_loss_batch_allocations(batch_id);

alter table public.sale_batch_allocations enable row level security;
alter table public.stock_loss_batch_allocations enable row level security;

drop policy if exists sale_batch_allocations_owner on public.sale_batch_allocations;
create policy sale_batch_allocations_owner on public.sale_batch_allocations
  for select to authenticated using (owner_id = auth.uid());
drop policy if exists stock_loss_batch_allocations_owner on public.stock_loss_batch_allocations;
create policy stock_loss_batch_allocations_owner on public.stock_loss_batch_allocations
  for select to authenticated using (owner_id = auth.uid());

revoke insert, update, delete on public.sale_batch_allocations from authenticated;
revoke insert, update, delete on public.stock_loss_batch_allocations from authenticated;
grant select on public.sale_batch_allocations, public.stock_loss_batch_allocations to authenticated;

-- Preserve an exact allocation when a new receipt is used to cost a legacy
-- deficit. New sales cannot oversell, but older projects may still contain one.
create or replace function public.receive_stock(p_product_id uuid,p_quantity integer,p_unit_cost bigint,p_supplier text,p_paid bigint,p_note text)
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
  select name into v_name from products where id = p_product_id and owner_id = v_owner for update;
  if not found then raise exception 'Product not found'; end if;

  insert into stock_batches(owner_id,product_id,quantity,remaining,unit_cost,supplier,paid,note)
    values(v_owner,p_product_id,p_quantity,p_quantity,p_unit_cost,coalesce(p_supplier,''),p_paid,coalesce(p_note,''))
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

create or replace function public.record_sale(p_id uuid,p_lines jsonb,p_payments jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_day uuid;
  v_line jsonb;
  v_payment jsonb;
  v_product record;
  v_batch record;
  v_sale_line_id uuid;
  v_quantity integer;
  v_needed integer;
  v_used integer;
  v_price bigint;
  v_total bigint := 0;
  v_cost bigint := 0;
  v_line_cost bigint;
  v_paid bigint := 0;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  select id into v_day from business_days
    where owner_id = v_owner and date = (now() at time zone 'Africa/Kigali')::date and status = 'open'
    for update;
  if v_day is null then raise exception 'Open today''s business day first'; end if;
  if exists(select 1 from sales where id = p_id and owner_id = v_owner) then return; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Sale has no lines'; end if;

  insert into sales(id,owner_id,day_id,total,cost) values(p_id,v_owner,v_day,0,0);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    v_price := (v_line->>'unitPrice')::bigint;
    if v_quantity is null or v_quantity <= 0 or v_price is null or v_price < 0 then raise exception 'Invalid sale line'; end if;

    select id,name,stock into v_product from products
      where id = (v_line->>'productId')::uuid and owner_id = v_owner and active
      for update;
    if not found then raise exception 'Product not found'; end if;
    if v_product.stock < v_quantity then raise exception 'Not enough stock for %', v_product.name; end if;

    insert into sale_lines(owner_id,sale_id,product_id,product_name,quantity,unit_price,unit_cost,cost_deficit)
      values(v_owner,p_id,v_product.id,v_product.name,v_quantity,v_price,0,0)
      returning id into v_sale_line_id;

    v_needed := v_quantity;
    v_line_cost := 0;
    for v_batch in
      select id,remaining,unit_cost from stock_batches
        where owner_id = v_owner and product_id = v_product.id and remaining > 0
        order by received_at,id for update
    loop
      exit when v_needed = 0;
      v_used := least(v_needed,v_batch.remaining);
      update stock_batches set remaining = remaining - v_used where id = v_batch.id;
      insert into sale_batch_allocations(owner_id,sale_id,sale_line_id,batch_id,quantity,unit_cost)
        values(v_owner,p_id,v_sale_line_id,v_batch.id,v_used,v_batch.unit_cost);
      v_line_cost := v_line_cost + v_used::bigint * v_batch.unit_cost;
      v_needed := v_needed - v_used;
    end loop;
    if v_needed > 0 then raise exception 'Missing purchase cost for %', v_product.name; end if;

    update sale_lines set unit_cost = v_line_cost where id = v_sale_line_id;
    update products set stock = stock - v_quantity where id = v_product.id;
    v_total := v_total + v_quantity::bigint * v_price;
    v_cost := v_cost + v_line_cost;
  end loop;

  if jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','momo','bank') or (v_payment->>'amount')::bigint <= 0 then raise exception 'Invalid payment'; end if;
    insert into payments(owner_id,sale_id,method,amount)
      values(v_owner,p_id,v_payment->>'method',(v_payment->>'amount')::bigint);
    v_paid := v_paid + (v_payment->>'amount')::bigint;
  end loop;
  if v_total <> v_paid then raise exception 'Payments do not match sale total'; end if;

  update sales set total = v_total,cost = v_cost,has_cost_deficit = false where id = p_id;
  insert into activity_logs(owner_id,action,detail)
    values(v_owner,'Sale completed',p_id::text || ' · RWF ' || v_total::text);
end $$;

create or replace function public.edit_sale(p_sale_id uuid,p_lines jsonb,p_payments jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_sale record;
  v_line record;
  v_input jsonb;
  v_batch record;
  v_allocation record;
  v_new_quantity integer;
  v_new_price bigint;
  v_delta integer;
  v_needed integer;
  v_used integer;
  v_remove integer;
  v_return integer;
  v_allocated integer;
  v_available integer;
  v_new_cost bigint;
  v_total bigint := 0;
  v_cost bigint := 0;
  v_paid bigint := 0;
  v_payment jsonb;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Sale has no lines'; end if;
  if jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;

  select s.* into v_sale from sales s join business_days d on d.id = s.day_id
    where s.id = p_sale_id and s.owner_id = v_owner
      and d.date = (now() at time zone 'Africa/Kigali')::date and d.status = 'open'
    for update of s;
  if not found then raise exception 'Only sales from the open business day can be edited'; end if;
  if v_sale.has_cost_deficit then raise exception 'Resolve this sale''s missing stock cost before editing it'; end if;
  if jsonb_array_length(p_lines) <> (select count(*) from sale_lines where sale_id = p_sale_id and owner_id = v_owner) then
    raise exception 'Products cannot be added or removed while correcting a sale';
  end if;

  for v_line in select * from sale_lines where sale_id = p_sale_id and owner_id = v_owner for update loop
    select coalesce(sum(quantity),0)::integer into v_allocated
      from sale_batch_allocations where sale_line_id = v_line.id and owner_id = v_owner;
    if v_allocated <> v_line.quantity then
      raise exception 'This sale predates batch tracking and is view-only';
    end if;

    select value into v_input from jsonb_array_elements(p_lines)
      where value->>'productId' = v_line.product_id::text limit 1;
    if v_input is null then raise exception 'Products cannot be changed while correcting a sale'; end if;
    v_new_quantity := (v_input->>'quantity')::integer;
    v_new_price := (v_input->>'unitPrice')::bigint;
    if v_new_quantity is null or v_new_quantity <= 0 or v_new_price is null or v_new_price < 0 then raise exception 'Invalid sale line'; end if;
    v_delta := v_new_quantity - v_line.quantity;

    select stock into v_available from products
      where id = v_line.product_id and owner_id = v_owner for update;
    if v_delta > v_available then raise exception 'Not enough stock for this correction'; end if;

    if v_delta > 0 then
      v_needed := v_delta;
      for v_batch in
        select id,remaining,unit_cost from stock_batches
          where owner_id = v_owner and product_id = v_line.product_id and remaining > 0
          order by received_at,id for update
      loop
        exit when v_needed = 0;
        v_used := least(v_needed,v_batch.remaining);
        update stock_batches set remaining = remaining - v_used where id = v_batch.id;
        insert into sale_batch_allocations(owner_id,sale_id,sale_line_id,batch_id,quantity,unit_cost)
          values(v_owner,p_sale_id,v_line.id,v_batch.id,v_used,v_batch.unit_cost)
          on conflict (sale_line_id,batch_id) do update
            set quantity = sale_batch_allocations.quantity + excluded.quantity;
        v_needed := v_needed - v_used;
      end loop;
      if v_needed > 0 then raise exception 'Not enough costed stock for this correction'; end if;
    elsif v_delta < 0 then
      v_remove := -v_delta;
      for v_allocation in
        select a.id,a.batch_id,a.quantity
          from sale_batch_allocations a join stock_batches b on b.id = a.batch_id
          where a.owner_id = v_owner and a.sale_line_id = v_line.id
          order by b.received_at desc,b.id desc
          for update of a
      loop
        exit when v_remove = 0;
        v_return := least(v_remove,v_allocation.quantity);
        update stock_batches set remaining = remaining + v_return where id = v_allocation.batch_id;
        if v_return = v_allocation.quantity then
          delete from sale_batch_allocations where id = v_allocation.id;
        else
          update sale_batch_allocations set quantity = quantity - v_return where id = v_allocation.id;
        end if;
        v_remove := v_remove - v_return;
      end loop;
      if v_remove > 0 then raise exception 'Batch allocation is incomplete'; end if;
    end if;

    select coalesce(sum(quantity::bigint * unit_cost),0) into v_new_cost
      from sale_batch_allocations where sale_line_id = v_line.id and owner_id = v_owner;
    update products set stock = stock - v_delta where id = v_line.product_id and owner_id = v_owner;
    update sale_lines set quantity = v_new_quantity,unit_price = v_new_price,unit_cost = v_new_cost where id = v_line.id;
    v_total := v_total + v_new_quantity::bigint * v_new_price;
    v_cost := v_cost + v_new_cost;
  end loop;

  delete from payments where sale_id = p_sale_id and owner_id = v_owner;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','momo','bank') or (v_payment->>'amount')::bigint <= 0 then raise exception 'Invalid payment'; end if;
    insert into payments(owner_id,sale_id,method,amount)
      values(v_owner,p_sale_id,v_payment->>'method',(v_payment->>'amount')::bigint);
    v_paid := v_paid + (v_payment->>'amount')::bigint;
  end loop;
  if v_paid <> v_total then raise exception 'Payments do not match sale total'; end if;

  update sales set total = v_total,cost = v_cost where id = p_sale_id;
  insert into activity_logs(owner_id,action,detail)
    values(v_owner,'Sale edited',p_sale_id::text || ' · RWF ' || v_total::text);
end $$;

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
  v_loss_id uuid;
  v_needed integer;
  v_used integer;
  v_cost bigint := 0;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_reason not in ('Damaged','Expired','Stolen','Missing','Other') then raise exception 'Invalid stock loss reason'; end if;

  select id,name,unit,stock into v_product from products
    where id = p_product_id and owner_id = v_owner and active for update;
  if not found then raise exception 'Product not found'; end if;
  if v_product.stock < p_quantity then raise exception 'Only % % available', v_product.stock, v_product.unit; end if;

  insert into stock_losses(owner_id,product_id,quantity,cost,reason,note)
    values(v_owner,p_product_id,p_quantity,0,p_reason,trim(coalesce(p_note,'')))
    returning id into v_loss_id;

  v_needed := p_quantity;
  for v_batch in
    select id,remaining,unit_cost from stock_batches
      where owner_id = v_owner and product_id = p_product_id and remaining > 0
      order by received_at,id for update
  loop
    exit when v_needed = 0;
    v_used := least(v_needed,v_batch.remaining);
    update stock_batches set remaining = remaining - v_used where id = v_batch.id;
    insert into stock_loss_batch_allocations(owner_id,loss_id,batch_id,quantity,unit_cost)
      values(v_owner,v_loss_id,v_batch.id,v_used,v_batch.unit_cost);
    v_cost := v_cost + v_used::bigint * v_batch.unit_cost;
    v_needed := v_needed - v_used;
  end loop;
  if v_needed > 0 then raise exception 'Missing purchase cost for %', v_product.name; end if;

  update stock_losses set cost = v_cost where id = v_loss_id;
  update products set stock = stock - p_quantity where id = p_product_id and owner_id = v_owner;
  insert into activity_logs(owner_id,action,detail)
    values(v_owner,'Stock loss recorded',p_quantity::text || ' × ' || v_product.name || ' · ' || p_reason || ' · RWF ' || v_cost::text);
  return v_cost;
end $$;

create or replace function public.get_stock_batch_report(p_from date default null,p_to date default null)
returns table (
  batch_id uuid,
  received_at timestamptz,
  product_id uuid,
  product_name text,
  category text,
  unit text,
  quantity_received integer,
  quantity_sold bigint,
  quantity_lost bigint,
  quantity_untracked bigint,
  quantity_remaining integer,
  unit_cost bigint,
  sales_revenue bigint,
  cost_of_goods bigint,
  stock_loss_cost bigint,
  realized_contribution bigint,
  status text
)
language sql stable security definer set search_path = public as $$
  select
    b.id,
    b.received_at,
    b.product_id,
    p.name,
    p.category,
    p.unit,
    b.quantity,
    coalesce(sold.quantity,0),
    coalesce(lost.quantity,0),
    greatest((b.quantity - b.remaining)::bigint - coalesce(sold.quantity,0) - coalesce(lost.quantity,0),0),
    b.remaining,
    b.unit_cost,
    coalesce(sold.revenue,0),
    coalesce(sold.cost,0),
    coalesce(lost.cost,0),
    case
      when (b.quantity - b.remaining)::bigint > coalesce(sold.quantity,0) + coalesce(lost.quantity,0) then null
      else coalesce(sold.revenue,0) - coalesce(sold.cost,0) - coalesce(lost.cost,0)
    end,
    case
      when (b.quantity - b.remaining)::bigint > coalesce(sold.quantity,0) + coalesce(lost.quantity,0) then 'Legacy gap'
      when b.remaining = 0 then 'Finished'
      else 'Open'
    end
  from stock_batches b
  join products p on p.id = b.product_id
  left join lateral (
    select
      sum(a.quantity)::bigint as quantity,
      sum(a.quantity::bigint * sl.unit_price)::bigint as revenue,
      sum(a.quantity::bigint * a.unit_cost)::bigint as cost
    from sale_batch_allocations a
    join sale_lines sl on sl.id = a.sale_line_id
    where a.batch_id = b.id
  ) sold on true
  left join lateral (
    select
      sum(a.quantity)::bigint as quantity,
      sum(a.quantity::bigint * a.unit_cost)::bigint as cost
    from stock_loss_batch_allocations a
    where a.batch_id = b.id
  ) lost on true
  where b.owner_id = auth.uid()
    and (p_from is null or (b.received_at at time zone 'Africa/Kigali')::date >= p_from)
    and (p_to is null or (b.received_at at time zone 'Africa/Kigali')::date <= p_to)
  order by b.received_at desc,b.id desc;
$$;

revoke all on function public.receive_stock(uuid,integer,bigint,text,bigint,text), public.record_sale(uuid,jsonb,jsonb), public.edit_sale(uuid,jsonb,jsonb), public.record_stock_loss(uuid,integer,text,text), public.get_stock_batch_report(date,date) from public;
grant execute on function public.receive_stock(uuid,integer,bigint,text,bigint,text), public.record_sale(uuid,jsonb,jsonb), public.edit_sale(uuid,jsonb,jsonb), public.record_stock_loss(uuid,integer,text,text), public.get_stock_batch_report(date,date) to authenticated;
