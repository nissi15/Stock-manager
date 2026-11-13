-- Apply before deploying the offline-queue client. This function never moves a
-- late sale to the current day: the original day must still be open.
-- This migration replaces Claude's alternate 0012_queued_sale_timestamps.sql;
-- do not apply both implementations to the same project.
begin;

create or replace function public.record_offline_sale(
  p_id uuid,
  p_sold_at timestamptz,
  p_day_date date,
  p_lines jsonb,
  p_payments jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_day uuid;
  v_opened_at timestamptz;
  v_existing_owner uuid;
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
  if p_id is null then raise exception 'Invalid offline sale'; end if;

  -- Serialize two browser tabs retrying the same ID. The second invocation
  -- waits for the first to commit and then sees the completed sale below.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));

  -- A response can be lost after commit. A retry with the same ID is an
  -- acknowledgement, including when the day has since closed.
  select owner_id into v_existing_owner from public.sales where id = p_id;
  if found then
    if v_existing_owner <> v_owner then raise exception 'Sale ID belongs to another account'; end if;
    return;
  end if;
  if p_sold_at is null or p_day_date is null then raise exception 'Invalid offline sale'; end if;
  if (p_sold_at at time zone 'Africa/Kigali')::date <> p_day_date or p_sold_at > now() + interval '5 minutes' then
    raise exception 'Offline sale time does not match its business day';
  end if;

  select id,opened_at into v_day,v_opened_at from public.business_days
    where owner_id = v_owner and date = p_day_date and status = 'open'
    for update;
  if v_day is null then raise exception 'The original business day is closed or missing. Reconcile this offline sale before closing the day'; end if;
  if p_sold_at < v_opened_at - interval '5 minutes' then raise exception 'Offline sale predates the business day opening'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Sale has no lines'; end if;
  if jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;

  insert into public.sales(id,owner_id,day_id,created_at,total,cost)
    values(p_id,v_owner,v_day,p_sold_at,0,0);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer;
    v_price := (v_line->>'unitPrice')::bigint;
    if v_quantity is null or v_quantity <= 0 or v_price is null or v_price < 0 then raise exception 'Invalid sale line'; end if;

    select id,name,stock into v_product from public.products
      where id = (v_line->>'productId')::uuid and owner_id = v_owner and active
      for update;
    if not found then raise exception 'Product not found'; end if;
    if v_product.stock < v_quantity then raise exception 'Not enough stock for %; offline sale needs review',v_product.name; end if;

    insert into public.sale_lines(owner_id,sale_id,product_id,product_name,quantity,unit_price,unit_cost,cost_deficit)
      values(v_owner,p_id,v_product.id,v_product.name,v_quantity,v_price,0,0)
      returning id into v_sale_line_id;

    v_needed := v_quantity;
    v_line_cost := 0;
    for v_batch in
      select id,remaining,unit_cost from public.stock_batches
        where owner_id = v_owner and product_id = v_product.id and remaining > 0
        order by received_at,id for update
    loop
      exit when v_needed = 0;
      v_used := least(v_needed,v_batch.remaining);
      update public.stock_batches set remaining = remaining - v_used where id = v_batch.id;
      insert into public.sale_batch_allocations(owner_id,sale_id,sale_line_id,batch_id,quantity,unit_cost)
        values(v_owner,p_id,v_sale_line_id,v_batch.id,v_used,v_batch.unit_cost);
      v_line_cost := v_line_cost + v_used::bigint * v_batch.unit_cost;
      v_needed := v_needed - v_used;
    end loop;
    if v_needed > 0 then raise exception 'Missing purchase cost for %; offline sale needs review',v_product.name; end if;

    update public.sale_lines set unit_cost = v_line_cost where id = v_sale_line_id;
    update public.products set stock = stock - v_quantity where id = v_product.id;
    v_total := v_total + v_quantity::bigint * v_price;
    v_cost := v_cost + v_line_cost;
  end loop;

  for v_payment in select value from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','momo','bank') or (v_payment->>'amount')::bigint <= 0 then raise exception 'Invalid payment'; end if;
    insert into public.payments(owner_id,sale_id,method,amount)
      values(v_owner,p_id,v_payment->>'method',(v_payment->>'amount')::bigint);
    v_paid := v_paid + (v_payment->>'amount')::bigint;
  end loop;
  if v_total <> v_paid then raise exception 'Payments do not match sale total'; end if;

  update public.sales set total = v_total,cost = v_cost,has_cost_deficit = false where id = p_id;
  insert into public.activity_logs(owner_id,action,detail)
    values(v_owner,'Offline sale synchronized',p_id::text || ' · sold ' || p_sold_at::text || ' · RWF ' || v_total::text);
end $$;

revoke execute on function public.record_offline_sale(uuid,timestamptz,date,jsonb,jsonb) from public, anon;
grant execute on function public.record_offline_sale(uuid,timestamptz,date,jsonb,jsonb) to authenticated;

commit;
