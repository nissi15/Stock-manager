import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';

function isPrivilegedKey(value: string | undefined) {
  if (!value) return false;
  if (value.startsWith('sb_secret_')) return true;
  try {
    const payload = value.split('.')[1];
    if (!payload) return false;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)).role === 'service_role';
  } catch {
    return false;
  }
}

if (!demoMode && isPrivilegedKey(key)) {
  throw new Error('Refusing to expose a Supabase secret/service-role key in the browser. Use a publishable key.');
}

export const supabase = !demoMode && url && key ? createClient(url, key) : null;
