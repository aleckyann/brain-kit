---
type: llm
weight: 1
---

O modelo carrega a skill certa. A resposta apresenta a instalação em ordem: conferir Node 24 ou mais novo, git e `gh auth status`, e rodar o `doctor` do kit; perguntar uma coisa de cada vez se o vault é novo ou já existe; coletar as respostas do init no chat e rodar `init <dir> --from-answers <arquivo>` (ou `init --adopt <dir> --from-answers <arquivo>`); recomendar um repositório privado porque o vault guarda notas sobre pessoas; fechar com `machine register` e `doctor`. Deixa `gh auth login` e qualquer credencial para a pessoa. Não afirma ter rodado um comando que não tinha ferramenta para rodar.
