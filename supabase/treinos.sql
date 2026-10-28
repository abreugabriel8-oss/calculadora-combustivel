-- Calculadora Combustível: trazer treino (TrainingPeaks pelo link de calendário e leitura por IA)
-- Rode DEPOIS de pagamentos.sql: SQL Editor > New query > colar tudo > Run. Pode rodar de novo.

-- 1. Link do calendário do TrainingPeaks de cada pessoa
-- O link dá acesso ao calendário de treinos: só a função "treinos" (chave de serviço) lê e grava.
create table if not exists public.calendarios (
  user_id uuid primary key references auth.users (id) on delete cascade,
  url text not null,
  origem text not null default 'trainingpeaks',
  criado_em timestamptz not null default now()
);
alter table public.calendarios enable row level security;
revoke all on public.calendarios from anon, authenticated;

-- 2. Leituras de treino por IA por dia (limite contra abuso)
create table if not exists public.uso_ia (
  user_id uuid not null references auth.users (id) on delete cascade,
  dia date not null default current_date,
  n int not null default 0,
  primary key (user_id, dia)
);
alter table public.uso_ia enable row level security;
revoke all on public.uso_ia from anon, authenticated;

create or replace function public.usar_ia(p_user uuid)
returns int language sql security definer set search_path = '' as $$
  insert into public.uso_ia (user_id, dia, n) values (p_user, current_date, 1)
  on conflict (user_id, dia) do update set n = public.uso_ia.n + 1
  returning n;
$$;
revoke all on function public.usar_ia(uuid) from public, anon, authenticated;
grant execute on function public.usar_ia(uuid) to service_role;

-- 3. A pessoa tem acesso ao app agora? (mesma regra do app: teste de 3 dias, pago, paciente ou profissional)
create or replace function public.tem_acesso(p_user uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select
    exists (select 1 from public.profissionais p where p.user_id = p_user)
    or exists (select 1 from public.vinculos v where v.paciente_id = p_user and v.status = 'ativo')
    or coalesce((select greatest(a.ate, a.cortesia_ate) > now() from public.acessos a where a.user_id = p_user), false)
    or coalesce((select greatest(u.created_at, c.inicio) + make_interval(days => c.dias_teste) > now()
                 from auth.users u, public.config_pro c where u.id = p_user), false);
$$;
revoke all on function public.tem_acesso(uuid) from public, anon, authenticated;
grant execute on function public.tem_acesso(uuid) to service_role;
