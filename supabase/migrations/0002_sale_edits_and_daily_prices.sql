-- Run after 0001_initial.sql. Adds audited daily-price updates and same-day sale corrections.

create or replace function public.update_daily_prices(p_prices jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_day uuid; v_product record; v_price bigint;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  select id into v_day from business_days
    where owner_id = v_owner and date = (now() at time zone 'Africa/Kigali')::date and status = 'open'
    for update;
  if v_day is null then raise exception 'Open today''s business day first'; end if;
  for v_product in select id from products where owner_id = v_owner and active loop
    v_price := (p_prices ->> v_product.id::text)::bigint;
    if v_price is null or v_price < 0 then raise exception 'Every active product needs a valid price'; end if;
    insert into daily_prices(owner_id,day_id,product_id,price)
      values(v_owner,v_day,v_product.id,v_price)
      on conflict (day_id,product_id) do update set price = excluded.price;
    update products set price = v_price where id = v_product.id and owner_id = v_owner;
  end loop;
  insert into activity_logs(owner_id,action,detail)
    values(v_owner,'Daily prices updated',(now() at time zone 'Africa/Kigali')::date::text);
end $$;

create or replace function public.edit_sale(p_sale_id uuid,p_lines jsonb,p_payments jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid(); v_sale record; v_line record; v_input jsonb; v_batch record;
  v_new_quantity integer; v_new_price bigint; v_delta integer; v_needed integer; v_used integer;
  v_new_cost bigint; v_total bigint := 0; v_cost bigint := 0; v_paid bigint := 0; v_payment jsonb;
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
    select value into v_input from jsonb_array_elements(p_lines)
      where value->>'productId' = v_line.product_id::text limit 1;
    if v_input is null then raise exception 'Products cannot be changed while correcting a sale'; end if;
    v_new_quantity := (v_input->>'quantity')::integer;
    v_new_price := (v_input->>'unitPrice')::bigint;
    if v_new_quantity is null or v_new_quantity <= 0 or v_new_price is null or v_new_price < 0 then raise exception 'Invalid sale line'; end if;
    v_delta := v_new_quantity - v_line.quantity;
    v_new_cost := case when v_delta > 0 then v_line.unit_cost else round(v_line.unit_cost::numeric * v_new_quantity / v_line.quantity)::bigint end;

    if v_delta > 0 then
      v_needed := v_delta;
      for v_batch in select id,remaining,unit_cost from stock_batches
        where owner_id = v_owner and product_id = v_line.product_id and remaining > 0
        order by received_at,id for update loop
        exit when v_needed = 0;
        v_used := least(v_needed,v_batch.remaining);
        update stock_batches set remaining = remaining - v_used where id = v_batch.id;
        v_new_cost := v_new_cost + v_used::bigint*v_batch.unit_cost;
        v_needed := v_needed - v_used;
      end loop;
      if v_needed > 0 then raise exception 'Not enough costed stock for this correction'; end if;
    elsif v_delta < 0 then
      insert into stock_batches(owner_id,product_id,quantity,remaining,unit_cost,supplier,paid,note)
        values(v_owner,v_line.product_id,-v_delta,-v_delta,
          case when v_line.quantity > 0 then round(v_line.unit_cost::numeric/v_line.quantity)::bigint else 0 end,
          '',0,'Stock restored by sale correction');
    end if;

    update products set stock = stock - v_delta where id = v_line.product_id and owner_id = v_owner;
    update sale_lines set quantity = v_new_quantity,unit_price = v_new_price,unit_cost = v_new_cost where id = v_line.id;
    v_total := v_total + v_new_quantity::bigint*v_new_price;
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

revoke all on function public.update_daily_prices(jsonb), public.edit_sale(uuid,jsonb,jsonb) from public;
grant execute on function public.update_daily_prices(jsonb), public.edit_sale(uuid,jsonb,jsonb) to authenticated;
