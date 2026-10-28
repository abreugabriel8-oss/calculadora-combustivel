-- Calculadora Combustível: notificações (véspera do treino longo, pós-treino e assinatura)
-- Rode DEPOIS de pagamentos.sql e treinos.sql: SQL Editor > New query > colar tudo > Run. Pode rodar de novo.
-- Antes, crie a função "notificar" (Edge Functions), com Verify JWT DESLIGADO.

-- 1. Aparelhos inscritos para receber notificações (só a função "notificar" lê e grava)
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  criado_em timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subs (user_id);
alter table public.push_subs enable row level security;
revoke all on public.push_subs from anon, authenticated;

-- 2. O que cada pessoa quer receber
create table if not exists public.notif_prefs (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  vespera boolean not null default true,
  pos boolean not null default true,
  assinatura boolean not null default true,
  hora_vespera int not null default 20 check (hora_vespera between 17 and 22),
  tz text not null default 'America/Sao_Paulo',
  atualizado_em timestamptz not null default now()
);
alter table public.notif_prefs enable row level security;
drop policy if exists "notif_prefs: o próprio" on public.notif_prefs;
create policy "notif_prefs: o próprio" on public.notif_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.notif_prefs to authenticated;

-- 3. Sessão planejada no app (uma por dia): base da véspera e do lembrete pós-treino
create table if not exists public.sessoes_plan (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data date not null,
  hora time,
  dur_min int not null check (dur_min between 1 and 2000),
  titulo text not null default '',
  resumo text not null default '',
  prova boolean not null default false,
  atualizado_em timestamptz not null default now(),
  primary key (user_id, data)
);
alter table public.sessoes_plan enable row level security;
drop policy if exists "sessoes_plan: o próprio" on public.sessoes_plan;
create policy "sessoes_plan: o próprio" on public.sessoes_plan for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.sessoes_plan to authenticated;

-- 4. O que já foi enviado (nunca manda a mesma coisa duas vezes)
create table if not exists public.notif_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  chave text not null,
  enviado_em timestamptz not null default now(),
  primary key (user_id, chave)
);
alter table public.notif_log enable row level security;
revoke all on public.notif_log from anon, authenticated;

-- 5. Chaves do envio (geradas sozinhas pela função) e senha do agendador
create table if not exists public.config_push (
  id int primary key default 1 check (id = 1),
  vapid_pub text,
  vapid_priv text,
  cron_segredo text not null default replace(gen_random_uuid()::text, '-', '')
);
insert into public.config_push (id) values (1) on conflict (id) do nothing;
alter table public.config_push enable row level security;
revoke all on public.config_push from anon, authenticated;

-- 6. Quem recebe o quê agora (usadas só pela função, com a chave de serviço)
create or replace function public.notif_tem_acesso(p_user uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select
    exists (select 1 from public.profissionais p where p.user_id = p_user)
    or exists (select 1 from public.vinculos v where v.paciente_id = p_user and v.status = 'ativo')
    or coalesce((select greatest(a.ate, a.cortesia_ate) > now() from public.acessos a where a.user_id = p_user), false)
    or coalesce((select greatest(u.created_at, c.inicio) + make_interval(days => c.dias_teste) > now()
                 from auth.users u, public.config_pro c where u.id = p_user), false);
$$;

-- véspera: está no horário escolhido (até 2 h depois) e ainda não avisou sobre amanhã
create or replace function public.notif_alvos_vespera()
returns table (user_id uuid, amanha date, tz text, plano jsonb, cal_url text)
language sql security definer set search_path = '' stable as $$
  select p.user_id, l.amanha, p.tz,
    (select to_jsonb(s) from public.sessoes_plan s where s.user_id = p.user_id and s.data = l.amanha),
    (select c.url from public.calendarios c where c.user_id = p.user_id)
  from public.notif_prefs p
  cross join lateral (select (now() at time zone p.tz) as agora) a
  cross join lateral (select (a.agora::date + 1) as amanha) l
  where p.vespera
    and extract(hour from a.agora) >= p.hora_vespera and extract(hour from a.agora) < p.hora_vespera + 2
    and exists (select 1 from public.push_subs ps where ps.user_id = p.user_id)
    and not exists (select 1 from public.notif_log n where n.user_id = p.user_id and n.chave = 'vespera:' || l.amanha)
    and public.notif_tem_acesso(p.user_id);
$$;

-- pós-treino: de 10 min a 4 h depois do fim previsto (ou de uma atividade nova do Garmin) e sem registro no dia
create or replace function public.notif_alvos_pos()
returns table (user_id uuid, dia date, titulo text)
language sql security definer set search_path = '' stable as $$
  select s.user_id, s.data, s.titulo
  from public.sessoes_plan s
  join public.notif_prefs p on p.user_id = s.user_id
  where p.pos and s.hora is not null
    and s.data between (now() at time zone p.tz)::date - 1 and (now() at time zone p.tz)::date
    and now() between ((s.data + s.hora) at time zone p.tz) + make_interval(mins => s.dur_min + 10)
                  and ((s.data + s.hora) at time zone p.tz) + make_interval(mins => s.dur_min + 240)
    and exists (select 1 from public.push_subs ps where ps.user_id = s.user_id)
    and not exists (select 1 from public.registros r where r.user_id = s.user_id and r.data = s.data)
    and not exists (select 1 from public.notif_log n where n.user_id = s.user_id and n.chave = 'pos:' || s.data)
    and public.notif_tem_acesso(s.user_id)
  union
  select g.user_id, (g.recebido_em at time zone p.tz)::date, ''
  from public.garmin_atividades g
  join public.notif_prefs p on p.user_id = g.user_id
  where p.pos and not g.registrado and g.recebido_em > now() - interval '3 hours'
    and exists (select 1 from public.push_subs ps where ps.user_id = g.user_id)
    and not exists (select 1 from public.registros r where r.user_id = g.user_id and r.data = (g.recebido_em at time zone p.tz)::date)
    and not exists (select 1 from public.notif_log n where n.user_id = g.user_id and n.chave = 'pos:' || (g.recebido_em at time zone p.tz)::date)
    and public.notif_tem_acesso(g.user_id);
$$;

-- assinatura: teste grátis acabando (menos de 24 h) ou Pro vencendo (2 a 3 dias), das 9 h às 21 h
create or replace function public.notif_alvos_assinatura()
returns table (user_id uuid, tipo text, fim timestamptz, tz text)
language sql security definer set search_path = '' stable as $$
  with base as (
    select p.user_id, p.tz,
      greatest(u.created_at, c.inicio) + make_interval(days => c.dias_teste) as teste_fim,
      (select greatest(a.ate, a.cortesia_ate) from public.acessos a where a.user_id = p.user_id) as pago_fim
    from public.notif_prefs p
    join auth.users u on u.id = p.user_id
    cross join public.config_pro c
    where p.assinatura
      and extract(hour from now() at time zone p.tz) between 9 and 20
      and exists (select 1 from public.push_subs ps where ps.user_id = p.user_id)
      and not exists (select 1 from public.profissionais pr where pr.user_id = p.user_id)
      and not exists (select 1 from public.vinculos v where v.paciente_id = p.user_id and v.status = 'ativo')
  )
  select b.user_id, 'teste', b.teste_fim, b.tz from base b
  where b.teste_fim between now() and now() + interval '24 hours'
    and coalesce(b.pago_fim, '-infinity') < b.teste_fim
    and not exists (select 1 from public.notif_log n where n.user_id = b.user_id and n.chave = 'teste_fim')
  union all
  select b.user_id, 'pro', b.pago_fim, b.tz from base b
  where b.pago_fim between now() + interval '2 days' and now() + interval '3 days'
    and not exists (select 1 from public.notif_log n where n.user_id = b.user_id and n.chave = 'pro_fim:' || (b.pago_fim at time zone b.tz)::date);
$$;

revoke all on function public.notif_tem_acesso(uuid) from public, anon, authenticated;
revoke all on function public.notif_alvos_vespera() from public, anon, authenticated;
revoke all on function public.notif_alvos_pos() from public, anon, authenticated;
revoke all on function public.notif_alvos_assinatura() from public, anon, authenticated;
grant execute on function public.notif_tem_acesso(uuid) to service_role;
grant execute on function public.notif_alvos_vespera() to service_role;
grant execute on function public.notif_alvos_pos() to service_role;
grant execute on function public.notif_alvos_assinatura() to service_role;

-- 7. Agendador: chama a função "notificar" a cada 15 minutos
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('notificar') where exists (select 1 from cron.job where jobname = 'notificar');
select cron.schedule('notificar', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://ivvmptiaoruatyvensqe.supabase.co/functions/v1/notificar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select cron_segredo from public.config_push where id = 1)),
    body := '{"action":"rodar"}'::jsonb
  );
$cron$);
