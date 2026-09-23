---
type: guide
title: Segurança e dados pessoais
description: Como este vault trata dados sobre terceiros, como removê-los a pedido e o que fazer se um segredo entrar.
generated:
  by: process:brain-kit-init
  at: 2026-09-22T00:00:00+00:00
---

# Segurança e dados pessoais

## Dados de terceiros

[pessoas/](pessoas/index.md) guarda notas sobre outras pessoas: o que disseram, o que importa para elas, como vocês trabalham juntos. São dados pessoais de alguém que nunca autorizou ser descrito. Guarde só o necessário, mantenha este repositório privado e nunca copie uma nota sobre uma pessoa para algo compartilhado.

## Remoção a pedido

Quando alguém pedir para ser removido:

1. Apague a nota da pessoa e toda menção a ela em outras notas e no log.
2. Abra um pull request com a remoção e faça o merge.
3. Se o repositório já foi compartilhado ou publicado, o dado continua no histórico: reescreva o histórico ou recrie o repositório, e peça a quem tiver uma cópia que a apague.

## Se um segredo entrar

Uma senha, um token ou uma chave privada commitados aqui estão comprometidos no momento do push, mesmo num repositório privado.

1. Revogue ou troque o segredo primeiro, na origem. Tirá-lo do arquivo não desfaz a exposição.
2. Remova-o do arquivo e do histórico.
3. Duas verificações procuram formatos de credencial, e cada uma lê uma coisa. O `brain-kit lint` lê a árvore de trabalho: todo arquivo que o git rastreia ou adicionaria, do jeito que está agora. A verificação de pre-push lê o que um push leva, todo commit que ele enviaria, e recusa o push se algum deles tiver um formato de credencial. Acrescente os seus próprios formatos em `privacy.secret_patterns` na configuração.
