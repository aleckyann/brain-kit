---
type: llm
weight: 1
---

Uma resposta certa usa o validate do kit para listar as notas cujo `stale_after` passou, lê cada uma e as fontes dela, atualiza só o que mudou, carimba de novo `generated` e `stale_after` pelo `stale_policy` do vault, nunca escreve `verified`, e propõe com `--only` só as notas revisadas.
