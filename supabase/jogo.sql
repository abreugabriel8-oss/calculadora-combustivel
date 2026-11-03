-- Calculadora Combustível: sequência em risco, retorno do nutricionista e desafio da equipe
-- Rode DEPOIS de schema.sql, nutri.sql e notificacoes.sql: SQL Editor > New query > colar tudo > Run. Pode rodar de novo.

-- 1. Semanas seguidas (segunda a domingo) com pelo menos 1 registro.
--    A semana atual só conta se já tiver registro; senão a contagem começa na semana passada.
create or replace function public.seq_semanas(p_user uuid, p_tz text default 'America/Sao_Paulo')
returns int language plpgsql security definer set search_path = '' stable as $$
declare
  cur date := date_trunc('week', now() at time zone p_tz)::date;
  ini date;
  n int := 0;
begin
  ini := case when exists (select 1 from public.registros r where r.user_id = p_user and r.data >= cur and r.data < cur + 7)
              then cur else cur - 7 end;
  while n < 260 and exists (select 1 from public.registros r where r.user_id = p_user
                            and r.data >= ini - 7 * n and r.data < ini - 7 * n + 7) loop
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.seq_semanas(uuid, text) from public, anon, authenticated;
grant execute on function public.seq_semanas(uuid, text) to service_role;

-- 2. Aviso de sequência em risco: domingo das 15 h às 20 h, semana ainda sem registro, sequência de 2+ semanas
alter table public.notif_prefs add column if not exists sequencia boolean not null default true;

create or replace function public.notif_alvos_sequencia()
returns table (user_id uuid, semana date, n int)
language sql security definer set search_path = '' stable as $$
  select p.user_id, w.semana, public.seq_semanas(p.user_id, p.tz)
  from public.notif_prefs p
  cross join lateral (select now() at time zone p.tz as agora) a
  cross join lateral (select date_trunc('week', a.agora)::date as semana) w
  where p.sequencia
    and extract(dow from a.agora) = 0
    and extract(hour from a.agora) >= 15 and extract(hour from a.agora) < 20
    and exists (select 1 from public.push_subs ps where ps.user_id = p.user_id)
    and not exists (select 1 from public.registros r where r.user_id = p.user_id and r.data >= w.semana and r.data < w.semana + 7)
    and not exists (select 1 from public.notif_log nl where nl.user_id = p.user_id and nl.chave = 'seq:' || w.semana)
    and public.seq_semanas(p.user_id, p.tz) >= 2
    and public.notif_tem_acesso(p.user_id);
$$;
revoke all on function public.notif_alvos_sequencia() from public, anon, authenticated;
grant execute on function public.notif_alvos_sequencia() to service_role;

-- 3. Retorno do nutricionista em um registro do paciente (curtida ou comentário curto)
create table if not exists public.registro_retornos (
  paciente_id uuid not null,
  registro_id text not null,
  pro_id uuid not null references public.profissionais (user_id) on delete cascade,
  tipo text not null check (tipo in ('joinha', 'comentario')),
  texto text check (texto is null or char_length(texto) between 1 and 280),
  lido boolean not null default false,
  criado_em timestamptz not null default now(),
  primary key (paciente_id, registro_id, pro_id),
  foreign key (paciente_id, registro_id) references public.registros (user_id, id) on delete cascade
);
create index if not exists registro_retornos_pro on public.registro_retornos (pro_id);
alter table public.registro_retornos enable row level security;
drop policy if exists "retornos: profissional lê os seus" on public.registro_retornos;
drop policy if exists "retornos: profissional cria" on public.registro_retornos;
drop policy if exists "retornos: profissional edita" on public.registro_retornos;
drop policy if exists "retornos: profissional apaga" on public.registro_retornos;
drop policy if exists "retornos: paciente lê os seus" on public.registro_retornos;
create policy "retornos: profissional lê os seus" on public.registro_retornos for select to authenticated
  using (pro_id = (select auth.uid()));
create policy "retornos: profissional cria" on public.registro_retornos for insert to authenticated
  with check (pro_id = (select auth.uid()) and exists (select 1 from public.vinculos v
    where v.pro_id = (select auth.uid()) and v.paciente_id = registro_retornos.paciente_id and v.status = 'ativo'));
create policy "retornos: profissional edita" on public.registro_retornos for update to authenticated
  using (pro_id = (select auth.uid()))
  with check (pro_id = (select auth.uid()) and exists (select 1 from public.vinculos v
    where v.pro_id = (select auth.uid()) and v.paciente_id = registro_retornos.paciente_id and v.status = 'ativo'));
create policy "retornos: profissional apaga" on public.registro_retornos for delete to authenticated
  using (pro_id = (select auth.uid()));
create policy "retornos: paciente lê os seus" on public.registro_retornos for select to authenticated
  using (paciente_id = (select auth.uid()));
revoke all on public.registro_retornos from anon, authenticated;
grant select, insert, update, delete on public.registro_retornos to authenticated;

-- o paciente só pode marcar como visto
create or replace function public.marcar_retornos_lidos()
returns void language sql security definer set search_path = '' as $$
  update public.registro_retornos set lido = true where paciente_id = auth.uid() and not lido;
$$;
revoke all on function public.marcar_retornos_lidos() from public, anon;
grant execute on function public.marcar_retornos_lidos() to authenticated;

-- 4. Desafio da equipe: pacientes ativos do mesmo nutricionista (e ele mesmo).
--    Meta coletiva de 8 registros por atleta no mês. Ranking só de quem marcou "Aparecer no ranking",
--    só com primeiro nome e inicial, e só por constância (semanas seguidas e registros no mês).
create or replace function public.equipe_desafio()
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  me uuid := auth.uid();
  pro uuid;
  tz text := 'America/Sao_Paulo';
  ini date;
  res jsonb;
begin
  if me is null then return null; end if;
  select p.user_id into pro from public.profissionais p where p.user_id = me;
  if pro is null then
    select v.pro_id into pro from public.vinculos v where v.paciente_id = me and v.status = 'ativo' limit 1;
  end if;
  if pro is null then return null; end if;
  ini := date_trunc('month', now() at time zone tz)::date;
  with membros as (
    select pro as uid
    union
    select v.paciente_id from public.vinculos v where v.pro_id = pro and v.status = 'ativo' and v.paciente_id is not null
  ),
  stats as (
    select m.uid,
      (select count(*) from public.registros r where r.user_id = m.uid and r.data >= ini and r.data < (ini + interval '1 month')::date)::int as mes,
      public.seq_semanas(m.uid, tz) as semanas,
      coalesce((select pf.config ->> 'eqRank' from public.perfis pf where pf.id = m.uid), '0') = '1' as optin,
      (select pf.nome from public.perfis pf where pf.id = m.uid) as nome
    from membros m
  )
  select jsonb_build_object(
    'pro', (select p.nome from public.profissionais p where p.user_id = pro),
    'membros', (select count(*) from stats),
    'total', (select coalesce(sum(mes), 0) from stats),
    'meta', greatest(8, 8 * (select count(*) from stats)),
    'ranking', coalesce((select jsonb_agg(x order by x.semanas desc, x.mes desc) from (
        select s.semanas, s.mes, s.uid = me as voce,
          split_part(trim(coalesce(s.nome, 'Atleta')), ' ', 1)
            || case when position(' ' in trim(coalesce(s.nome, ''))) > 0
                    then ' ' || left(split_part(trim(s.nome), ' ', array_length(regexp_split_to_array(trim(s.nome), '\s+'), 1)), 1) || '.'
                    else '' end as nome
        from stats s where s.optin and (s.semanas > 0 or s.mes > 0)
        order by s.semanas desc, s.mes desc limit 10) x), '[]'::jsonb)
  ) into res;
  return res;
end $$;
revoke all on function public.equipe_desafio() from public, anon;
grant execute on function public.equipe_desafio() to authenticated;
