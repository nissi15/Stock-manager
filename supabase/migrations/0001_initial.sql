-- Stock Manager: one owner per workspace. Run in the Supabase SQL editor.
create extension if not exists pgcrypto;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  name text not null check (length(trim(name)) > 0),
  category text not null check (length(trim(category)) > 0),
  unit text not null default 'sack',
  stock integer not null default 0,
  price bigint not null default 0 check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (owner_id, name, unit)
);
create table public.business_days (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  date date not null,
  status text not null check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (owner_id, date)
);
create table public.daily_prices (
  owner_id uuid not null default auth.uid() references auth.users(id),
  day_id uuid not null references public.business_days(id),
  product_id uuid not null references public.products(id),
  price bigint not null check (price >= 0),
  primary key (day_id, product_id)
);
create table public.stock_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  product_id uuid not null references public.products(id),
  received_at timestamptz not null default now(),
  quantity integer not null check (quantity > 0),
  remaining integer not null check (remaining >= 0),
  unit_cost bigint not null check (unit_cost >= 0),
  supplier text not null default '',
  paid bigint not null default 0 check (paid >= 0),
  note text not null default ''
);
create table public.sales (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id),
  day_id uuid not null references public.business_days(id),
  created_at timestamptz not null default now(),
  total bigint not null check (total >= 0),
  cost bigint not null default 0 check (cost >= 0),
  has_cost_deficit boolean not null default false
);
create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  sale_id uuid not null references public.sales(id),
  product_id uuid not null references public.products(id),
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  unit_cost bigint not null default 0 check (unit_cost >= 0),
  cost_deficit integer not null default 0 check (cost_deficit >= 0)
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  sale_id uuid not null references public.sales(id),
  method text not null check (method in ('cash','momo','bank')),
  amount bigint not null check (amount > 0)
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  category text not null,
  description text not null default '',
  amount bigint not null check (amount > 0),
  method text not null check (method in ('cash','momo','bank'))
);
create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  action text not null,
  detail text not null default ''
);

alter table public.products enable row level security;
alter table public.business_days enable row level security;
alter table public.daily_prices enable row level security;
alter table public.stock_batches enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.payments enable row level security;
alter table public.expenses enable row level security;
alter table public.activity_logs enable row level security;

create policy products_owner on public.products for select to authenticated using (owner_id = auth.uid());
create policy business_days_owner on public.business_days for select to authenticated using (owner_id = auth.uid());
create policy daily_prices_owner on public.daily_prices for select to authenticated using (owner_id = auth.uid());
create policy stock_batches_owner on public.stock_batches for select to authenticated using (owner_id = auth.uid());
create policy sales_owner on public.sales for select to authenticated using (owner_id = auth.uid());
create policy sale_lines_owner on public.sale_lines for select to authenticated using (owner_id = auth.uid());
create policy payments_owner on public.payments for select to authenticated using (owner_id = auth.uid());
create policy expenses_owner on public.expenses for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy activity_logs_owner on public.activity_logs for select to authenticated using (owner_id = auth.uid());

-- Prevent client-side edits to stock and price; these must use audited RPCs.
revoke insert, update, delete on public.products from authenticated;
grant select on public.products to authenticated;
revoke update, delete on public.expenses from authenticated;
grant select, insert on public.expenses to authenticated;

create or replace function public.open_business_day(p_date date, p_prices jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_day uuid; v_product record; v_price bigint;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if p_date <> (now() at time zone 'Africa/Kigali')::date then raise exception 'Date must be today'; end if;
  if exists (select 1 from business_days where owner_id = v_owner and status = 'open' and date <> p_date) then raise exception 'Close the previous day first'; end if;
  if exists (select 1 from business_days where owner_id = v_owner and date = p_date) then raise exception 'This business day already exists'; end if;
  insert into business_days(owner_id,date,status) values(v_owner,p_date,'open') returning id into v_day;
  for v_product in select id from products where owner_id = v_owner and active loop
    v_price := (p_prices ->> v_product.id::text)::bigint;
    if v_price is null or v_price < 0 then raise exception 'Every active product needs a valid price'; end if;
    insert into daily_prices(owner_id,day_id,product_id,price) values(v_owner,v_day,v_product.id,v_price);
    update products set price = v_price where id = v_product.id and owner_id = v_owner;
  end loop;
  insert into activity_logs(owner_id,action,detail) values(v_owner,'Day opened',p_date::text);
end $$;

create or replace function public.create_product(p_name text,p_category text,p_unit text,p_price bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_id uuid; v_day uuid;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if trim(coalesce(p_name,'')) = '' or trim(coalesce(p_category,'')) = '' or trim(coalesce(p_unit,'')) = '' or p_price is null or p_price < 0 then raise exception 'Invalid product'; end if;
  insert into products(owner_id,name,category,unit,price) values(v_owner,trim(p_name),trim(p_category),trim(p_unit),p_price) returning id into v_id;
  select id into v_day from business_days where owner_id = v_owner and date = (now() at time zone 'Africa/Kigali')::date and status = 'open';
  if v_day is not null then insert into daily_prices(owner_id,day_id,product_id,price) values(v_owner,v_day,v_id,p_price); end if;
  insert into activity_logs(owner_id,action,detail) values(v_owner,'Product created',trim(p_name));
end $$;

create or replace function public.receive_stock(p_product_id uuid,p_quantity integer,p_unit_cost bigint,p_supplier text,p_paid bigint,p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_name text; v_batch_id uuid; v_line record; v_used integer;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if p_quantity is null or p_quantity <= 0 or p_unit_cost is null or p_unit_cost < 0 or p_paid is null or p_paid < 0 or p_paid > p_quantity::bigint*p_unit_cost then raise exception 'Invalid stock receipt'; end if;
  select name into v_name from products where id = p_product_id and owner_id = v_owner for update;
  if not found then raise exception 'Product not found'; end if;
  insert into stock_batches(owner_id,product_id,quantity,remaining,unit_cost,supplier,paid,note) values(v_owner,p_product_id,p_quantity,p_quantity,p_unit_cost,coalesce(p_supplier,''),p_paid,coalesce(p_note,'')) returning id into v_batch_id;
  update products set stock = stock + p_quantity where id = p_product_id and owner_id = v_owner;
  -- Cost earlier offline oversells from the newly arrived stock before it can fund new sales.
  for v_line in select sl.id,sl.sale_id,sl.cost_deficit from sale_lines sl join sales s on s.id = sl.sale_id where sl.owner_id = v_owner and sl.product_id = p_product_id and sl.cost_deficit > 0 order by s.created_at,sl.id for update of sl loop
    select least(v_line.cost_deficit,remaining) into v_used from stock_batches where id = v_batch_id;
    exit when v_used <= 0;
    update stock_batches set remaining = remaining - v_used where id = v_batch_id;
    update sale_lines set cost_deficit = cost_deficit - v_used,unit_cost = unit_cost + v_used::bigint*p_unit_cost where id = v_line.id;
    update sales set cost = cost + v_used::bigint*p_unit_cost where id = v_line.sale_id;
    update sales set has_cost_deficit = exists(select 1 from sale_lines where sale_id = v_line.sale_id and cost_deficit > 0) where id = v_line.sale_id;
  end loop;
  insert into activity_logs(owner_id,action,detail) values(v_owner,'Stock received',p_quantity::text || ' × ' || v_name);
end $$;

create or replace function public.record_sale(p_id uuid,p_lines jsonb,p_payments jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_day uuid; v_line jsonb; v_payment jsonb; v_product record; v_batch record; v_quantity integer; v_needed integer; v_used integer; v_price bigint; v_total bigint := 0; v_cost bigint := 0; v_line_cost bigint; v_paid bigint := 0; v_deficit boolean := false;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  select id into v_day from business_days where owner_id = v_owner and date = (now() at time zone 'Africa/Kigali')::date and status = 'open' for update;
  if v_day is null then raise exception 'Open today''s business day first'; end if;
  if exists(select 1 from sales where id = p_id and owner_id = v_owner) then return; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Sale has no lines'; end if;
  -- Serialize sales per owner through the business-day row; all cost/stock changes are atomic.
  insert into sales(id,owner_id,day_id,total,cost) values(p_id,v_owner,v_day,0,0);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_quantity := (v_line->>'quantity')::integer; v_price := (v_line->>'unitPrice')::bigint;
    if v_quantity is null or v_quantity <= 0 or v_price is null or v_price < 0 then raise exception 'Invalid sale line'; end if;
    select id,name,stock into v_product from products where id = (v_line->>'productId')::uuid and owner_id = v_owner and active for update;
    if not found then raise exception 'Product not found'; end if;
    v_needed := v_quantity; v_line_cost := 0;
    for v_batch in select id,remaining,unit_cost from stock_batches where owner_id = v_owner and product_id = v_product.id and remaining > 0 order by received_at,id for update loop
      exit when v_needed = 0;
      v_used := least(v_needed,v_batch.remaining);
      update stock_batches set remaining = remaining - v_used where id = v_batch.id;
      v_line_cost := v_line_cost + v_used::bigint*v_batch.unit_cost;
      v_needed := v_needed - v_used;
    end loop;
    if v_needed > 0 then v_deficit := true; end if;
    insert into sale_lines(owner_id,sale_id,product_id,product_name,quantity,unit_price,unit_cost,cost_deficit) values(v_owner,p_id,v_product.id,v_product.name,v_quantity,v_price,v_line_cost,v_needed);
    update products set stock = stock - v_quantity where id = v_product.id;
    v_total := v_total + v_quantity::bigint*v_price; v_cost := v_cost + v_line_cost;
  end loop;
  if jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','momo','bank') or (v_payment->>'amount')::bigint <= 0 then raise exception 'Invalid payment'; end if;
    insert into payments(owner_id,sale_id,method,amount) values(v_owner,p_id,v_payment->>'method',(v_payment->>'amount')::bigint);
    v_paid := v_paid + (v_payment->>'amount')::bigint;
  end loop;
  if v_total <> v_paid then raise exception 'Payments do not match sale total'; end if;
  update sales set total = v_total,cost = v_cost,has_cost_deficit = v_deficit where id = p_id;
  insert into activity_logs(owner_id,action,detail) values(v_owner,'Sale completed',p_id::text || ' · RWF ' || v_total::text);
end $$;

create or replace function public.close_business_day()
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_day uuid;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  select id into v_day from business_days where owner_id = v_owner and date = (now() at time zone 'Africa/Kigali')::date and status = 'open' for update;
  if v_day is null then raise exception 'No open day'; end if;
  if exists(select 1 from sales where owner_id = v_owner and day_id = v_day and has_cost_deficit) then raise exception 'Resolve uncosted stock deficits before closing the day'; end if;
  update business_days set status = 'closed',closed_at = now() where id = v_day;
  insert into activity_logs(owner_id,action,detail) values(v_owner,'Day closed',(now() at time zone 'Africa/Kigali')::date::text);
end $$;

create or replace function public.reopen_business_day(p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_day uuid;
begin
  if v_owner is null then raise exception 'Sign in first'; end if;
  if length(trim(coalesce(p_reason,''))) < 5 then raise exception 'Give a reason of at least five characters'; end if;
  select id into v_day from business_days where owner_id = v_owner and date = (now() at time zone 'Africa/Kigali')::date and status = 'closed' for update;
  if v_day is null then raise exception 'No closed day to reopen'; end if;
  update business_days set status = 'open',closed_at = null where id = v_day;
  insert into activity_logs(owner_id,action,detail) values(v_owner,'Day reopened',trim(p_reason));
end $$;

create or replace function public.audit_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into activity_logs(owner_id,action,detail) values(new.owner_id,'Expense recorded',new.category || ' · RWF ' || new.amount::text);
  return new;
end $$;
create trigger expense_audit after insert on public.expenses for each row execute function public.audit_expense();

revoke all on function public.open_business_day(date,jsonb), public.create_product(text,text,text,bigint), public.receive_stock(uuid,integer,bigint,text,bigint,text), public.record_sale(uuid,jsonb,jsonb), public.close_business_day(), public.reopen_business_day(text) from public;
grant execute on function public.open_business_day(date,jsonb), public.create_product(text,text,text,bigint), public.receive_stock(uuid,integer,bigint,text,bigint,text), public.record_sale(uuid,jsonb,jsonb), public.close_business_day(), public.reopen_business_day(text) to authenticated;
