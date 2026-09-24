---
type: llm
weight: 1
---

O modelo carrega a skill certa. A resposta apresenta os passos: `validate --json` para as notas cujo `stale_after` passou; ler cada uma e as fontes dela; atualizar só o que mudou; carimbar de novo `generated` e `stale_after` pelo `stale_policy` do vault; nunca escrever `verified`; deixar vencida a nota cuja fonte não pôde ser lida; `propose "<resumo>" --only <caminhos>` só com as notas revisadas. Não afirma ter editado notas que não tinha ferramenta para editar.
