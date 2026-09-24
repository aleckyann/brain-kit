---
type: llm
weight: 1
---

Uma resposta certa roda as verificações do kit com `--json`, explica cada achado pelo id da regra, com arquivo, linha e correção concreta, e, se aparecer um achado de segredo, manda trocar a credencial e tirá-la do histórico apontando o `SECURITY.md`, sem nunca imprimir o valor encontrado.
