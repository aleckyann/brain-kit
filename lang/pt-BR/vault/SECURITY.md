---
type: guide
title: Segurança e dados pessoais
description: O que o curador guarda por padrão, como este vault trata dados sobre terceiros, como removê-los a pedido e o que fazer se um segredo entrar.
generated:
  by: process:brain-kit-init
  at: 2026-09-22T00:00:00+00:00
---

# Segurança e dados pessoais

## O que o curador guarda

Por padrão o curador guarda tudo o que aprende, inclusive informação pessoal e sensível (saúde, família, relacionamentos, finanças, qualquer coisa íntima), a sua e a de outras pessoas. Para guardar menos, ajuste `privacy.sensitive` no `brain-kit.config.json`, dando a cada um de `owner`, `people` e `outsiders` um destes níveis: `save`, `summary` ou `skip`, e liste em `privacy.never_topics` os assuntos que nunca devem ser registrados. Essa configuração é uma instrução para o curador, não uma garantia: leia cada pull request antes de fazer o merge.

## Dados de terceiros

[pessoas/](pessoas/index.md) guarda notas sobre outras pessoas: o que disseram, o que importa para elas, como vocês trabalham juntos. São dados pessoais de alguém que nunca autorizou ser descrito, e por padrão o curador os registra por inteiro, inclusive os assuntos sensíveis. Para leis de privacidade como a LGPD e o GDPR, a saúde, a vida sexual, a convicção religiosa ou a opinião política dessa pessoa são dados pessoais sensíveis, e quem responde por guardá-los é você, como dono do vault. Guarde só o necessário, mantenha este repositório privado e nunca copie uma nota sobre uma pessoa para algo compartilhado.

## Remoção a pedido

Quando alguém pedir para ser removido:

1. Apague a nota da pessoa e toda menção a ela em outras notas e no log.
2. Abra um pull request com a remoção e faça o merge.
3. Se o repositório já foi compartilhado ou publicado, o dado continua no histórico: reescreva o histórico ou recrie o repositório, e peça a quem tiver uma cópia que a apague.
4. O curador volta a registrar o que uma sessão, um evento ou um documento que ele lê ainda tiver. A nota da pessoa foi apagada, então ela conta como `outsiders`: para deixar de fora os assuntos sensíveis dela daí em diante, ajuste `privacy.sensitive.outsiders` para `skip` (vale para todos que não têm nota), ou liste o assunto em `privacy.never_topics`; a página passo a passo abaixo diz o que mais impede que isso volte.

## Se um segredo entrar

Uma senha, um token ou uma chave privada commitados aqui estão comprometidos no momento do push, mesmo num repositório privado.

1. Revogue ou troque o segredo primeiro, na origem. Tirá-lo do arquivo não desfaz a exposição.
2. Remova-o do arquivo e do histórico.
3. Duas verificações procuram formatos de credencial, e cada uma lê uma coisa. O `brain-kit lint` lê a árvore de trabalho: todo arquivo que o git rastreia ou adicionaria, do jeito que está agora. A verificação de pre-push lê o que um push leva, todo commit que ele enviaria, e recusa o push se algum deles tiver um formato de credencial. Acrescente os seus próprios formatos em `privacy.secret_patterns` na configuração.

A página passo a passo, na ordem em que as coisas devem ser feitas quando a pressão é alta (um segredo num commit, um repositório que ficou público por engano, dados pessoais de alguém para remover, um curador que fez o que não devia), é o `docs/incident-response.md` do repositório do brain-kit: https://github.com/aleckyann/brain-kit/blob/main/docs/incident-response.md
