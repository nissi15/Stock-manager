-- A business day left open overnight must still be closable before the next
-- day can start. Keep the normal reconciliation and immutable snapshot.
begin;

create or replace function public.close_business_day(p_counted_cash bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := auth.uid();
  v_day record;
  v_closing_id uuid := gen_random_uuid();
  v_closed_at timestamptz := now();
  v_sales_count bigint := 0;
  v_units_sold bigint := 0;
  v_revenue bigint := 0;
  v_cost bigint := 0;
  v_expenses bigint := 0;
  v_stock_loss bigint := 0;
  v_cash bigint := 0;
  v_momo bigint := 0;
  v_bank bigint := 0;
  v_cash_expenses bigint := 0;
  v_expected_cash bigint := 0;
  v_stock jsonb := '[]'::jsonb;
  v_snapshot jsonb;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if p_counted_cash is null or p_counted_cash < 0 then raise exception 'Counted cash must be zero or more'; end if;

  select * into v_day from business_days
    where owner_id = v_owner
      and date <= (now() at time zone 'Africa/Kigali')::date
      and status = 'open'
    order by date desc limit 1
    for update;
  if not found then raise exception 'No open day'; end if;
  if exists(select 1 from sales where owner_id = v_owner and day_id = v_day.id and has_cost_deficit) then
    raise exception 'Resolve uncosted stock deficits before closing the day';
  end if;

  select count(*),coalesce(sum(total),0),coalesce(sum(cost),0)
    into v_sales_count,v_revenue,v_cost
    from sales where owner_id = v_owner and day_id = v_day.id;
  select coalesce(sum(sl.quantity),0) into v_units_sold
    from sale_lines sl join sales s on s.id = sl.sale_id
    where sl.owner_id = v_owner and s.day_id = v_day.id;
  select
    coalesce(sum(case when p.method = 'cash' then p.amount else 0 end),0),
    coalesce(sum(case when p.method = 'momo' then p.amount else 0 end),0),
    coalesce(sum(case when p.method = 'bank' then p.amount else 0 end),0)
    into v_cash,v_momo,v_bank
    from payments p join sales s on s.id = p.sale_id
    where p.owner_id = v_owner and s.day_id = v_day.id;
  select coalesce(sum(amount),0),coalesce(sum(case when method = 'cash' then amount else 0 end),0)
    into v_expenses,v_cash_expenses
    from expenses
    where owner_id = v_owner and (created_at at time zone 'Africa/Kigali')::date = v_day.date;
  select coalesce(sum(cost),0) into v_stock_loss
    from stock_losses
    where owner_id = v_owner and (created_at at time zone 'Africa/Kigali')::date = v_day.date;
  -- A late close can only capture the stock currently on hand. The UI makes
  -- this limitation explicit before the user confirms the snapshot.
  select coalesce(jsonb_agg(jsonb_build_object(
      'productId',id,'name',name,'category',category,'unit',unit,'quantity',stock
    ) order by name,unit),'[]'::jsonb)
    into v_stock from products where owner_id = v_owner and active;

  v_expected_cash := v_cash - v_cash_expenses;
  v_snapshot := jsonb_build_object(
    'id',v_closing_id,
    'date',v_day.date,
    'openedAt',v_day.opened_at,
    'closedAt',v_closed_at,
    'salesCount',v_sales_count,
    'unitsSold',v_units_sold,
    'salesRevenue',v_revenue,
    'costOfGoods',v_cost,
    'grossProfit',v_revenue - v_cost,
    'expenseTotal',v_expenses,
    'stockLossTotal',v_stock_loss,
    'netProfit',v_revenue - v_cost - v_expenses - v_stock_loss,
    'payments',jsonb_build_object('cash',v_cash,'momo',v_momo,'bank',v_bank),
    'expectedCash',v_expected_cash,
    'countedCash',p_counted_cash,
    'cashDifference',p_counted_cash - v_expected_cash,
    'stockRemaining',v_stock
  );

  insert into business_day_closings(id,owner_id,day_id,closed_at,counted_cash,expected_cash,cash_difference,snapshot)
    values(v_closing_id,v_owner,v_day.id,v_closed_at,p_counted_cash,v_expected_cash,p_counted_cash-v_expected_cash,v_snapshot);
  update business_days set status = 'closed',closed_at = v_closed_at where id = v_day.id;
  insert into activity_logs(owner_id,action,detail)
    values(v_owner,'Day closed',v_day.date::text || ' · ' || v_sales_count::text || ' sales · Cash difference RWF ' || (p_counted_cash-v_expected_cash)::text);
  return v_snapshot;
end $$;

revoke all on function public.close_business_day(bigint) from public, anon;
grant execute on function public.close_business_day(bigint) to authenticated;

commit;
