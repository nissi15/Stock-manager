-- Emergency schema rollback for 0012_offline_sale_recovery.sql only.
-- Do not run while any device has queued sales: removing this RPC prevents
-- those devices from syncing until the migration is reapplied.
-- This removes the function; it does NOT undo sales, stock deductions,
-- payments, or activity already committed by it. Reconcile those separately.
begin;

revoke execute on function public.record_offline_sale(uuid,timestamptz,date,jsonb,jsonb)
  from authenticated;
drop function public.record_offline_sale(uuid,timestamptz,date,jsonb,jsonb);

commit;
