-- ═══════════════════════════════════════════════════════════════════════════
-- The vault the owner asked for — overturning ADM-84 §9.
--
-- ADM-84 §9 (2026-08-14) recorded "AgencyOS accepts no secret through a
-- form... the key vault waits for ADM-60; the encryption key is itself a
-- production credential and its custodian is one of ADM-60's five deferred
-- facts." ADM-60's five facts are answered (docs/deployment/runbook.md,
-- 2026-09-20) and the owner, asked directly whether to keep that rule or
-- overturn it, chose to overturn it: provider API keys may now be entered
-- through the Settings page and stored here, encrypted.
--
-- ── what this table is not ────────────────────────────────────────────────
--
-- It stores CIPHERTEXT only. The encryption itself happens in application
-- code (src/modules/ai/vault.ts, AES-256-GCM), keyed by VAULT_ENCRYPTION_KEY —
-- a Vercel-only secret, never written here, held by the same custodian ADM-60
-- named for SUPABASE_SERVICE_ROLE_KEY. A row in this table, read on its own,
-- decrypts to nothing: the key that would open it lives only in Vercel. This
-- is deliberately NOT done with pgcrypto/pgp_sym_encrypt in Postgres itself —
-- the first migration in this repository says "no extensions required" so
-- every migration applies against a plain Postgres, and encryption belongs in
-- code that can be unit-tested without a database at all.
--
-- ── global, not per-organization ──────────────────────────────────────────
--
-- Every provider ADM-85 named is served on the agency's OWN account — one
-- Anthropic account, one OpenAI account, and so on — never a per-tenant
-- billing relationship. `ai.models` and `ai.routing_policies` are
-- organization-scoped because model PREFERENCE is a tenant's own choice; the
-- credential that reaches the vendor is not. This table therefore carries no
-- organization_id, on the same footing as core.organizations and core.users —
-- verify-tenancy-guards' structural count only counts organization_id foreign
-- keys, so a table with none is correctly outside its scope rather than an
-- oversight it would otherwise catch.
--
-- Access is admin-only (core.is_admin(), the same tier ADM-19/60 give the
-- Configuration page) and every row change is who and when, never what the
-- plaintext was.
-- ═══════════════════════════════════════════════════════════════════════════

-- ciphertext/iv/auth_tag are `text` (base64), not `bytea`: PostgREST's bytea
-- wire format (\x-prefixed hex, and quirks around it) is untested anywhere
-- else in this codebase, and a silent encode/decode mismatch there is exactly
-- the kind of defect that passes a regex and fails only against a live
-- Postgres. Base64 text has no such edge and round-trips with Buffer.from(...,
-- 'base64') on both sides.
create table if not exists ai.provider_credentials (
  provider     text primary key check (provider in ('anthropic', 'openai', 'gemini', 'xai', 'openrouter')),
  ciphertext   text not null,
  iv           text not null,
  auth_tag     text not null,
  updated_by   uuid not null references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table ai.provider_credentials is
  'Encrypted AI provider API keys, admin-entered via Settings — ADM-84 §9 overturned 2026-09-20. Ciphertext only; VAULT_ENCRYPTION_KEY never touches this table.';

alter table ai.provider_credentials enable row level security;

create policy provider_credentials_admin_rw on ai.provider_credentials
  for all to authenticated
  using ((select core.is_admin()))
  with check ((select core.is_admin()));

revoke all on ai.provider_credentials from public, anon;
grant select, insert, update, delete on ai.provider_credentials to authenticated;
grant select, insert, update, delete on ai.provider_credentials to service_role;

-- ── touch updated_at / updated_by on every write ────────────────────────────
create or replace function ai.provider_credentials_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists provider_credentials_touch on ai.provider_credentials;
create trigger provider_credentials_touch
  before update on ai.provider_credentials
  for each row execute function ai.provider_credentials_touch();

-- ── status, for the Settings page: presence and moment, never the value ────
create or replace function ai.provider_credential_status()
returns table (provider text, configured boolean, updated_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.provider, (c.provider is not null) as configured, c.updated_at
  from unnest(array['anthropic', 'openai', 'gemini', 'xai', 'openrouter']) as p(provider)
  left join ai.provider_credentials c on c.provider = p.provider
  order by p.provider;
$$;

revoke all on function ai.provider_credential_status() from public, anon;
grant execute on function ai.provider_credential_status() to authenticated, service_role;

comment on function ai.provider_credential_status() is
  'Which providers have a vault-stored key and when it was last set. Never the ciphertext, never the plaintext. RLS on the underlying table still applies — an admin session only.';
