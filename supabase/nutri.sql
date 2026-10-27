-- Calculadora Combustível: modo nutricionista (etapa 2)
-- Rode tudo de uma vez no Supabase: SQL Editor > New query > colar > Run.
-- Pode rodar de novo sem quebrar nada. Depois, rode a linha que libera o seu e-mail como profissional
-- (ela está no fim deste arquivo, com SEU_EMAIL no lugar do e-mail).

-- 1. Profissionais (liberados à mão por enquanto) ----------------------------
create table if not exists public.profissionais (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  crn text,
  criado_em timestamptz not null default now()
);
alter table public.profissionais enable row level security;
drop policy if exists "profissionais: ler" on public.profissionais;
create policy "profissionais: ler" on public.profissionais for select to authenticated using (true);
revoke all on public.profissionais from anon, authenticated;
grant select on public.profissionais to authenticated;

-- 2. Vínculo profissional ↔ paciente, criado por convite ---------------------
create table if not exists public.vinculos (
  id uuid primary key default gen_random_uuid(),
  pro_id uuid not null references public.profissionais (user_id) on delete cascade,
  paciente_id uuid references auth.users (id) on delete set null,
  paciente_nome text not null,
  convite text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status text not null default 'pendente' check (status in ('pendente', 'ativo', 'encerrado')),
  metas jsonb not null default '{}'::jsonb,   -- suor por modalidade, sódio do suor, tolerância a carbo, recado
  notas text,                                  -- anotações só do profissional
  criado_em timestamptz not null default now(),
  aceito_em timestamptz
);
create index if not exists vinculos_pro on public.vinculos (pro_id);
create index if not exists vinculos_paciente on public.vinculos (paciente_id);
alter table public.vinculos enable row level security;

drop policy if exists "vinculos: profissional vê os seus" on public.vinculos;
drop policy if exists "vinculos: profissional cria" on public.vinculos;
drop policy if exists "vinculos: profissional edita" on public.vinculos;
drop policy if exists "vinculos: profissional apaga" on public.vinculos;
drop policy if exists "vinculos: paciente vê o seu" on public.vinculos;
create policy "vinculos: profissional vê os seus" on public.vinculos
  for select to authenticated using ((select auth.uid()) = pro_id);
create policy "vinculos: profissional cria" on public.vinculos
  for insert to authenticated with check (
    (select auth.uid()) = pro_id and exists (select 1 from public.profissionais p where p.user_id = (select auth.uid())));
create policy "vinculos: profissional edita" on public.vinculos
  for update to authenticated using ((select auth.uid()) = pro_id) with check ((select auth.uid()) = pro_id);
create policy "vinculos: profissional apaga" on public.vinculos
  for delete to authenticated using ((select auth.uid()) = pro_id);
create policy "vinculos: paciente vê o seu" on public.vinculos
  for select to authenticated using ((select auth.uid()) = paciente_id);

revoke all on public.vinculos from anon, authenticated;
grant select, delete on public.vinculos to authenticated;
grant insert (pro_id, paciente_nome, metas, notas) on public.vinculos to authenticated;
grant update (paciente_nome, metas, notas, status) on public.vinculos to authenticated;

-- 3. O profissional lê o diário e o perfil de quem aceitou o convite ---------
drop policy if exists "registros: profissional lê pacientes" on public.registros;
create policy "registros: profissional lê pacientes" on public.registros
  for select to authenticated using (exists (
    select 1 from public.vinculos v
    where v.pro_id = (select auth.uid()) and v.paciente_id = registros.user_id and v.status = 'ativo'));
drop policy if exists "perfil: profissional lê pacientes" on public.perfis;
create policy "perfil: profissional lê pacientes" on public.perfis
  for select to authenticated using (exists (
    select 1 from public.vinculos v
    where v.pro_id = (select auth.uid()) and v.paciente_id = perfis.id and v.status = 'ativo'));

-- 4. Convite: ver quem convidou (antes do login) e aceitar (depois) ---------
create or replace function public.convite_info(p_convite text)
returns json language sql security definer set search_path = '' stable as $$
  select json_build_object('profissional', p.nome, 'crn', p.crn, 'paciente', v.paciente_nome)
  from public.vinculos v join public.profissionais p on p.user_id = v.pro_id
  where v.convite = p_convite and v.status = 'pendente';
$$;
revoke all on function public.convite_info(text) from public;
grant execute on function public.convite_info(text) to anon, authenticated;

create or replace function public.aceitar_convite(p_convite text)
returns json language plpgsql security definer set search_path = '' as $$
declare v public.vinculos; pr public.profissionais;
begin
  select * into v from public.vinculos where convite = p_convite for update;
  if not found or v.status = 'encerrado' then raise exception 'convite_invalido'; end if;
  if v.paciente_id is not null and v.paciente_id <> auth.uid() then raise exception 'convite_usado'; end if;
  if v.pro_id = auth.uid() then raise exception 'convite_proprio'; end if;
  -- um acompanhamento ativo por vez
  update public.vinculos set status = 'encerrado' where paciente_id = auth.uid() and status = 'ativo' and id <> v.id;
  update public.vinculos set paciente_id = auth.uid(), status = 'ativo', aceito_em = coalesce(aceito_em, now()) where id = v.id;
  select * into pr from public.profissionais where user_id = v.pro_id;
  return json_build_object('profissional', pr.nome, 'crn', pr.crn);
end $$;
revoke all on function public.aceitar_convite(text) from public, anon;
grant execute on function public.aceitar_convite(text) to authenticated;

create or replace function public.encerrar_acompanhamento()
returns void language sql security definer set search_path = '' as $$
  update public.vinculos set status = 'encerrado' where paciente_id = auth.uid() and status = 'ativo';
$$;
revoke all on function public.encerrar_acompanhamento() from public, anon;
grant execute on function public.encerrar_acompanhamento() to authenticated;

-- 5. Liberar o seu usuário como profissional (troque SEU_EMAIL e rode) ------
-- insert into public.profissionais (user_id, nome, crn)
-- select id, 'Gabriel Abreu', 'CRN 23100384' from auth.users where email = 'SEU_EMAIL'
-- on conflict (user_id) do update set nome = excluded.nome, crn = excluded.crn;
