-- Offline-queued sales keep the time they were made.
-- Run after 0011_close_previous_business_day.sql.
--
-- record_sale gains an optional p_sold_at. When it is null (a normal online
-- sale) the behaviour is unchanged: the sale belongs to today's open day.
-- When a queued sale is synced later, p_sold_at is the time it was made on the
-- device, and the sale is recorded against the open business day for that date.
-- If that day is closed (or was never opened) the sale is rejected so it can be
-- reviewed instead of silently landing in another day's totals.
--
-- The idempotency check now runs before the day check, so retrying a sale that
-- was already recorded is a no-op even after its day has closed.
begin;

drop function if exists public.record_sale(uuid,jsonb,jsonb);

create or replace function public.record_sale(p_id uuid,p_lines jsonb,p_payments jsonb,p_sold_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_day record;
  v_at timestamptz;
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
  if exists(select 1 from sales where id = p_id and owner_id = v_owner) then return; end if;

  -- A device clock ahead of the server cannot create future sales.
  v_at := least(coalesce(p_sold_at,now()),now());
  select id,date,opened_at into v_day from business_days
    where owner_id = v_owner and date = (v_at at time zone 'Africa/Kigali')::date and status = 'open'
    for update;
  if not found then
    if p_sold_at is null then raise exception 'Open today''s business day first'; end if;
    raise exception 'The business day for this queued sale (%) is not open', (v_at at time zone 'Africa/Kigali')::date;
  end if;
  v_at := greatest(v_at,v_day.opened_at);

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Sale has no lines'; end if;

  insert into sales(id,owner_id,day_id,created_at,total,cost) values(p_id,v_owner,v_day.id,v_at,0,0);
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
    values(v_owner,
      case when p_sold_at is null then 'Sale completed' else 'Queued sale synced' end,
      p_id::text || ' · RWF ' || v_total::text);
end $$;

revoke all on function public.record_sale(uuid,jsonb,jsonb,timestamptz) from public, anon;
grant execute on function public.record_sale(uuid,jsonb,jsonb,timestamptz) to authenticated;

commit;
