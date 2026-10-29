-- Calculadora Combustível: integração com o Strava
-- Rode DEPOIS de garmin.sql e notificacoes.sql: SQL Editor > New query > colar tudo > Run. Pode rodar de novo.

-- 1. Conexão de cada atleta com o Strava (tokens ficam só no servidor)
create table if not exists public.strava_conexoes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  athlete_id bigint unique not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null default '',
  conectado_em timestamptz not null default now()
);
alter table public.strava_conexoes enable row level security;
revoke all on public.strava_conexoes from anon, authenticated;

-- 2. Atividades do Strava aguardando o registro no diário.
-- Pelas regras do Strava, ficam guardadas no máximo 7 dias (limpeza automática abaixo).
create table if not exists public.strava_atividades (
  user_id uuid not null references auth.users (id) on delete cascade,
  activity_id bigint not null,
  dados jsonb not null,
  recebido_em timestamptz not null default now(),
  registrado boolean not null default false,
  primary key (user_id, activity_id)
);
create index if not exists strava_atividades_pendentes on public.strava_atividades (user_id, registrado, recebido_em desc);
alter table public.strava_atividades enable row level security;
drop policy if exists "strava atividades: ler as próprias" on public.strava_atividades;
drop policy if exists "strava atividades: marcar as próprias" on public.strava_atividades;
drop policy if exists "strava atividades: apagar as próprias" on public.strava_atividades;
create policy "strava atividades: ler as próprias" on public.strava_atividades
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "strava atividades: marcar as próprias" on public.strava_atividades
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "strava atividades: apagar as próprias" on public.strava_atividades
  for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.strava_atividades from anon, authenticated;
grant select, delete on public.strava_atividades to authenticated;
grant update (registrado) on public.strava_atividades to authenticated;

-- 3. Configuração do aviso do Strava (criada sozinha; só o servidor lê)
create table if not exists public.config_strava (
  id int primary key default 1 check (id = 1),
  verify_token text not null default replace(gen_random_uuid()::text, '-', ''),
  webhook_id bigint
);
insert into public.config_strava (id) values (1) on conflict (id) do nothing;
alter table public.config_strava enable row level security;
revoke all on public.config_strava from anon, authenticated;

-- 4. Limpeza diária: nada do Strava fica guardado por mais de 7 dias
create extension if not exists pg_cron;
select cron.unschedule('strava_limpar') where exists (select 1 from cron.job where jobname = 'strava_limpar');
select cron.schedule('strava_limpar', '17 4 * * *', $cron$
  delete from public.strava_atividades where recebido_em < now() - interval '7 days';
$cron$);
