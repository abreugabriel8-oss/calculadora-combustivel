-- Calculadora Combustível: plano completo na conta, para abrir o mesmo plano no celular e no computador
-- Rode DEPOIS de notificacoes.sql: SQL Editor > New query > colar tudo > Run. Pode rodar de novo.

-- o plano inteiro (respostas do questionário, produtos e ajustes) vai junto da sessão planejada
alter table public.sessoes_plan add column if not exists estado jsonb;
alter table public.sessoes_plan drop constraint if exists sessoes_plan_estado_tamanho;
alter table public.sessoes_plan add constraint sessoes_plan_estado_tamanho
  check (estado is null or pg_column_size(estado) < 60000);
create index if not exists sessoes_plan_recente on public.sessoes_plan (user_id, atualizado_em desc);
