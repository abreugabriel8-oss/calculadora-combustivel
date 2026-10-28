-- Calculadora Combustível: plano Pro (pagamentos pelo Mercado Pago)
-- Rode DEPOIS de schema.sql e nutri.sql: SQL Editor > New query > colar tudo > Run.
-- Pode rodar de novo sem quebrar nada.

-- 1. Pagamentos ------------------------------------------------------------
-- Só a função "pagamento" (com a chave de serviço) escreve aqui. A pessoa só lê os próprios.
create table if not exists public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plano text not null check (plano in ('mensal', 'anual')),
  valor numeric(10, 2) not null,
  dias int not null,
  status text not null default 'pendente',     -- pendente, aprovado, recusado, estornado
  mp_preference_id text,
  mp_payment_id text unique,
  metodo text,                                  -- pix, credit_card, debit_card...
  criado_em timestamptz not null default now(),
  pago_em timestamptz
);
create index if not exists pagamentos_user on public.pagamentos (user_id, criado_em desc);
alter table public.pagamentos enable row level security;
drop policy if exists "pagamentos: ler os próprios" on public.pagamentos;
create policy "pagamentos: ler os próprios" on public.pagamentos
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.pagamentos from anon, authenticated;
grant select on public.pagamentos to authenticated;

-- 2. Acesso Pro --------------------------------------------------------------
-- ate: calculado a partir dos pagamentos aprovados. cortesia_ate: liberação manual sua.
create table if not exists public.acessos (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ate timestamptz,
  cortesia_ate timestamptz,
  atualizado_em timestamptz not null default now()
);
alter table public.acessos enable row level security;
drop policy if exists "acessos: ler o próprio" on public.acessos;
create policy "acessos: ler o próprio" on public.acessos
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.acessos from anon, authenticated;
grant select on public.acessos to authenticated;

-- 3. Recalcula o acesso somando os períodos pagos, em ordem (renovar antes do fim soma ao saldo)
create or replace function public.recalcular_acesso(p_user uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare fim timestamptz := null; r record;
begin
  for r in select pago_em, dias from public.pagamentos
           where user_id = p_user and status = 'aprovado' and pago_em is not null order by pago_em loop
    fim := greatest(coalesce(fim, r.pago_em), r.pago_em) + make_interval(days => r.dias);
  end loop;
  insert into public.acessos (user_id, ate) values (p_user, fim)
  on conflict (user_id) do update set ate = excluded.ate, atualizado_em = now();
  return fim;
end $$;
revoke all on function public.recalcular_acesso(uuid) from public, anon, authenticated;
grant execute on function public.recalcular_acesso(uuid) to service_role;

-- 4. Teste grátis: 3 dias de Pro contados da criação da conta.
-- Quem já tinha conta antes de você rodar este arquivo ganha os 3 dias a partir de hoje.
create table if not exists public.config_pro (
  id int primary key default 1 check (id = 1),
  inicio timestamptz not null default now(),
  dias_teste int not null default 3
);
insert into public.config_pro (id) values (1) on conflict (id) do nothing;
alter table public.config_pro enable row level security;
revoke all on public.config_pro from anon, authenticated;

-- 5. O que o app pergunta: até quando a pessoa é Pro e por quê
create or replace function public.meu_acesso()
returns json language sql security definer set search_path = '' stable as $$
  select json_build_object(
    'ready', true,
    'ate', (select greatest(a.ate, a.cortesia_ate) from public.acessos a where a.user_id = auth.uid()),
    'teste_ate', (select greatest(u.created_at, c.inicio) + make_interval(days => c.dias_teste)
                  from auth.users u, public.config_pro c where u.id = auth.uid()),
    'paciente', exists (select 1 from public.vinculos v where v.paciente_id = auth.uid() and v.status = 'ativo'),
    'profissional', exists (select 1 from public.profissionais p where p.user_id = auth.uid())
  );
$$;
revoke all on function public.meu_acesso() from public;
grant execute on function public.meu_acesso() to anon, authenticated;

-- 6. (Opcional) Cortesia extra para quem já tem conta antes do lançamento do Pro.
-- Tire os dois traços do começo das linhas abaixo e troque 30 pelo número de dias.
-- insert into public.acessos (user_id, cortesia_ate)
-- select id, now() + interval '30 days' from auth.users
-- on conflict (user_id) do update set cortesia_ate = greatest(public.acessos.cortesia_ate, excluded.cortesia_ate);
