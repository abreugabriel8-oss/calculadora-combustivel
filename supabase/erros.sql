-- Calculadora Combustível: erros que acontecem no app das pessoas
-- SQL Editor > New query > colar tudo > Run. Pode rodar de novo.
-- Guarda só a mensagem técnica do erro, a tela, o tipo de aparelho e a versão do app.
-- Nada do que a pessoa digitou. Cada aparelho manda no máximo 8 erros diferentes por visita.
-- Para ler: Table Editor > erros_resumo (agrupado) ou erros_app (um por um).

create table if not exists public.erros_app (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  mensagem text not null check (char_length(mensagem) between 1 and 300),
  linha int,
  coluna int,
  pilha text check (pilha is null or char_length(pilha) <= 1500),
  tela text check (tela is null or char_length(tela) <= 120),
  aparelho text check (aparelho is null or char_length(aparelho) <= 60),
  versao text check (versao is null or char_length(versao) <= 20),
  online boolean,
  criado_em timestamptz not null default now()
);
create index if not exists erros_app_criado on public.erros_app (criado_em desc);
alter table public.erros_app enable row level security;

-- qualquer visitante pode ENVIAR (quem ainda não criou conta também quebra o app);
-- ninguém pelo app consegue LER, alterar ou apagar
drop policy if exists "erros: enviar" on public.erros_app;
create policy "erros: enviar" on public.erros_app for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
revoke all on public.erros_app from anon, authenticated;
grant insert on public.erros_app to anon, authenticated;

-- visão agrupada: o mesmo erro aparece uma vez, com quantas vezes e quantas pessoas
create or replace view public.erros_resumo as
select
  mensagem,
  linha,
  count(*) as vezes,
  count(distinct coalesce(user_id::text, aparelho)) as pessoas_aprox,
  max(criado_em) as ultima_vez,
  min(criado_em) as primeira_vez,
  string_agg(distinct versao, ', ') as versoes,
  string_agg(distinct aparelho, ', ') as aparelhos,
  string_agg(distinct tela, ', ') as telas
from public.erros_app
where criado_em > now() - interval '30 days'
group by mensagem, linha
order by max(criado_em) desc;
revoke all on public.erros_resumo from anon, authenticated;

-- limpeza: erros com mais de 60 dias são apagados sozinhos
create extension if not exists pg_cron;
select cron.unschedule('erros_limpar') where exists (select 1 from cron.job where jobname = 'erros_limpar');
select cron.schedule('erros_limpar', '23 4 * * *', $cron$
  delete from public.erros_app where criado_em < now() - interval '60 days';
$cron$);
