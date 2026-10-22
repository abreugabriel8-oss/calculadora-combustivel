-- Calculadora Combustível: integração Garmin Connect
-- Rode no Supabase: SQL Editor > New query > colar > Run. Pode rodar de novo sem quebrar nada.

-- 1. Conexão de cada atleta com o Garmin (tokens ficam só no servidor) -------
create table if not exists public.garmin_conexoes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  garmin_user_id text unique,
  access_token text not null,
  refresh_token text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  permissions text[] not null default '{}',
  conectado_em timestamptz not null default now()
);
alter table public.garmin_conexoes enable row level security;
-- Sem nenhuma regra de acesso: o navegador nunca lê nem grava tokens.
revoke all on public.garmin_conexoes from anon, authenticated;

-- 2. Atividades recebidas do Garmin, aguardando o registro no diário ----------
create table if not exists public.garmin_atividades (
  user_id uuid not null references auth.users (id) on delete cascade,
  summary_id text not null,
  dados jsonb not null,
  recebido_em timestamptz not null default now(),
  registrado boolean not null default false,
  primary key (user_id, summary_id)
);
create index if not exists garmin_atividades_pendentes on public.garmin_atividades (user_id, registrado, recebido_em desc);
alter table public.garmin_atividades enable row level security;

drop policy if exists "garmin atividades: ler as próprias" on public.garmin_atividades;
drop policy if exists "garmin atividades: marcar as próprias" on public.garmin_atividades;
drop policy if exists "garmin atividades: apagar as próprias" on public.garmin_atividades;
create policy "garmin atividades: ler as próprias" on public.garmin_atividades
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "garmin atividades: marcar as próprias" on public.garmin_atividades
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "garmin atividades: apagar as próprias" on public.garmin_atividades
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.garmin_atividades from anon, authenticated;
grant select, delete on public.garmin_atividades to authenticated;
grant update (registrado) on public.garmin_atividades to authenticated;
