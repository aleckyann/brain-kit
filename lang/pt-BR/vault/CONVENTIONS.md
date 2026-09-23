---
type: guide
title: Convenções
description: Como as notas deste cofre são nomeadas, datadas, ligadas e organizadas, para que todo agente e toda pessoa as escrevam do mesmo jeito.
generated:
  by: process:brain-kit-init
  at: 2026-09-22T00:00:00+00:00
---

# Convenções

## Arquivos

- Nomes de arquivo em minúsculas, sem acento, com as palavras unidas por hífen: `ritmo-semanal.md`.
- Todo diretório tem um `index.md` que liga as notas de dentro dele. Um índice não leva frontmatter.
- Uma nota nova começa pelo modelo da sua coleção em [templates/](templates/index.md).

## Frontmatter

Toda nota começa com o frontmatter do OKF v0.2:

- `type` (obrigatório): o que a nota é, como `person`, `project` ou `decision`.
- `title` e `description`: um nome e uma frase dizendo o que a nota guarda.
- `generated`: `by` (quem escreveu) e `at` (quando), uma data e hora ISO 8601 com o deslocamento de UTC, como `2026-01-31T09:00:00-03:00`.

Atores em `generated.by`: o dono é `human:` seguido do seu identificador; um agente é `brain-kit-curator/` seguido do seu modelo; uma execução agendada é `process:brain-kit-curate`.

O estado de uma nota (aberta, concluída, arquivada) vai em `situacao`, nunca em `status`, que o formato reserva para o ciclo de vida da nota: `draft`, `stable` ou `deprecated`.

## Links

- Links são relativos à nota que os contém: `../pessoas/index.md`, `outra-nota.md`.
- Nunca comece um link com barra e nunca use um wikilink entre colchetes duplos.

## Tabelas

Os cabeçalhos das colunas de [pendencias/acompanhamentos.md](pendencias/acompanhamentos.md), [pendencias/promessas.md](pendencias/promessas.md) e [nucleo/ritmo-semanal.md](nucleo/ritmo-semanal.md) são uma interface entre o agente e a nota. Renomeie um cabeçalho na configuração e na nota ao mesmo tempo, ou não renomeie.

## O log

[memoria/log.md](memoria/log.md) tem um heading por dia, o mais recente primeiro, e cada entrada começa com um marcador em negrito: **Captura**, **Promovido**, **Correção** ou **Criação**.
