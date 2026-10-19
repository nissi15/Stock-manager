-- Make report dates describe activity in the period, not only batch arrival dates.
-- A row is included when the batch arrived, sold units, or lost units in the range.

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
    coalesce(sold_period.quantity,0),
    coalesce(lost_period.quantity,0),
    greatest((b.quantity - b.remaining)::bigint - coalesce(sold_all.quantity,0) - coalesce(lost_all.quantity,0),0),
    b.remaining,
    b.unit_cost,
    coalesce(sold_period.revenue,0),
    coalesce(sold_period.cost,0),
    coalesce(lost_period.cost,0),
    case
      when (b.quantity - b.remaining)::bigint > coalesce(sold_all.quantity,0) + coalesce(lost_all.quantity,0) then null
      else coalesce(sold_period.revenue,0) - coalesce(sold_period.cost,0) - coalesce(lost_period.cost,0)
    end,
    case
      when (b.quantity - b.remaining)::bigint > coalesce(sold_all.quantity,0) + coalesce(lost_all.quantity,0) then 'Legacy gap'
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
    join sales s on s.id = a.sale_id
    where a.batch_id = b.id
      and (p_from is null or (s.created_at at time zone 'Africa/Kigali')::date >= p_from)
      and (p_to is null or (s.created_at at time zone 'Africa/Kigali')::date <= p_to)
  ) sold_period on true
  left join lateral (
    select
      sum(a.quantity)::bigint as quantity,
      sum(a.quantity::bigint * a.unit_cost)::bigint as cost
    from stock_loss_batch_allocations a
    join stock_losses l on l.id = a.loss_id
    where a.batch_id = b.id
      and (p_from is null or (l.created_at at time zone 'Africa/Kigali')::date >= p_from)
      and (p_to is null or (l.created_at at time zone 'Africa/Kigali')::date <= p_to)
  ) lost_period on true
  left join lateral (
    select sum(a.quantity)::bigint as quantity
    from sale_batch_allocations a
    where a.batch_id = b.id
  ) sold_all on true
  left join lateral (
    select sum(a.quantity)::bigint as quantity
    from stock_loss_batch_allocations a
    where a.batch_id = b.id
  ) lost_all on true
  where b.owner_id = auth.uid()
    and (
      ((p_from is null or (b.received_at at time zone 'Africa/Kigali')::date >= p_from)
        and (p_to is null or (b.received_at at time zone 'Africa/Kigali')::date <= p_to))
      or coalesce(sold_period.quantity,0) > 0
      or coalesce(lost_period.quantity,0) > 0
    )
  order by b.received_at desc,b.id desc;
$$;

revoke all on function public.get_stock_batch_report(date,date) from public;
grant execute on function public.get_stock_batch_report(date,date) to authenticated;
