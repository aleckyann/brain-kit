---
type: llm
weight: 1
---

O modelo carrega a skill certa. A resposta apresenta os passos da curadoria em ordem: `sync` primeiro; entradas sob o título de hoje no log, cada uma com o marcador de captura; notas carimbadas com o `generated` do agente; nunca `verified`; `validate` e `lint` até passarem; `propose "<resumo>" --only <caminhos>` listando só os arquivos desta sessão; conferir que a base do pull request é o branch padrão; nada de merge. Não afirma ter escrito arquivos ou aberto pull request que não tinha ferramenta para escrever ou abrir.
