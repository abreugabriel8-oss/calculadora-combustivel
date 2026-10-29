-- Calculadora Combustível: sugestões e problemas enviados pelo app
-- SQL Editor > New query > colar tudo > Run. Pode rodar de novo.
-- Para ler: Table Editor > sugestoes (ordene por criado_em).
create table if not exists public.sugestoes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  email text,
  tipo text not null check (tipo in ('ideia', 'problema', 'duvida', 'elogio')),
  texto text not null check (char_length(texto) between 3 and 2000),
  tela text,
  aparelho text,
  versao text,
  criado_em timestamptz not null default now()
);
alter table public.sugestoes enable row level security;
drop policy if exists "sugestoes: enviar" on public.sugestoes;
create policy "sugestoes: enviar" on public.sugestoes for insert to authenticated
  with check (user_id = auth.uid());
revoke all on public.sugestoes from anon, authenticated;
grant insert on public.sugestoes to authenticated;
