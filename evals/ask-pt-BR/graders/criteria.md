---
type: llm
weight: 1
---

O modelo carrega a skill certa. Ele lê a partir do `index.md`, só as notas necessárias, e responde citando os caminhos em que se apoiou, avisando quando uma nota não está verificada ou passou do `stale_after`. Quando a resposta não está lá, diz qual estado vale (não verificado, não encontrado ou não sei) em vez de inventar.
