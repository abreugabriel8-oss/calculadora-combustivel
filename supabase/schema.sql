-- Calculadora Combustível: banco de dados (etapa 1, atleta)
-- Rode tudo de uma vez no Supabase: SQL Editor > New query > colar > Run.
-- Pode rodar de novo sem quebrar nada.

-- 1. Perfil de cada usuário ------------------------------------------------
create table if not exists public.perfis (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text,
  papel text not null default 'atleta' check (papel in ('atleta', 'nutricionista')),
  config jsonb not null default '{}'::jsonb,       -- peso, perfil de suor, tolerância etc.
  consentimento_em timestamptz,                    -- aceite LGPD para dados de saúde
  criado_em timestamptz not null default now()
);

-- 2. Registros do diário pós-treino ---------------------------------------
create table if not exists public.registros (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data date not null,
  dados jsonb not null,
  criado_em timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists registros_user_data on public.registros (user_id, data desc);

-- 3. Segurança por linha: cada pessoa só enxerga e altera o que é dela ------
alter table public.perfis enable row level security;
alter table public.registros enable row level security;

drop policy if exists "perfil: ler o próprio" on public.perfis;
drop policy if exists "perfil: criar o próprio" on public.perfis;
drop policy if exists "perfil: editar o próprio" on public.perfis;
create policy "perfil: ler o próprio" on public.perfis
  for select to authenticated using ((select auth.uid()) = id);
create policy "perfil: criar o próprio" on public.perfis
  for insert to authenticated with check ((select auth.uid()) = id);
create policy "perfil: editar o próprio" on public.perfis
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "registros: ler os próprios" on public.registros;
drop policy if exists "registros: criar os próprios" on public.registros;
drop policy if exists "registros: editar os próprios" on public.registros;
drop policy if exists "registros: apagar os próprios" on public.registros;
create policy "registros: ler os próprios" on public.registros
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "registros: criar os próprios" on public.registros
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "registros: editar os próprios" on public.registros
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "registros: apagar os próprios" on public.registros
  for delete to authenticated using ((select auth.uid()) = user_id);

-- 4. Permissões: visitante sem login não acessa nada; ninguém muda o próprio papel
revoke all on public.perfis, public.registros from anon;
revoke all on public.perfis from authenticated;
grant select on public.perfis to authenticated;
grant insert (id, nome, config, consentimento_em) on public.perfis to authenticated;
grant update (id, nome, config, consentimento_em) on public.perfis to authenticated;  -- id: exigido pelo upsert; a regra acima impede trocar por outro
grant select, insert, update, delete on public.registros to authenticated;

-- 5. Excluir a própria conta e todos os dados (direito previsto na LGPD) ---
create or replace function public.excluir_minha_conta()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = (select auth.uid());
$$;
revoke all on function public.excluir_minha_conta() from public, anon;
grant execute on function public.excluir_minha_conta() to authenticated;
