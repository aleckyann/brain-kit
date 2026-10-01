---
type: llm
weight: 1
---

O modelo carrega a skill certa. A resposta apresenta a instalação em ordem: conferir Node 22 ou mais novo, git, `gh auth status` e `claude --version`, e depois o `doctor` do kit numa pasta que não é um vault, como conferência da máquina (fora de um vault ele confere só a máquina); perguntar uma coisa de cada vez se o vault é novo ou já existe; coletar as respostas do init no chat e rodar `init <dir> --from-answers <arquivo>` (ou `init --adopt <dir> --from-answers <arquivo>`) e depois `doctor <dir>`; recomendar um repositório privado porque o vault guarda notas sobre pessoas, criado com `gh repo create <nome> --private --source <dir> --push` depois do primeiro commit; fechar com `machine register` e `doctor`. Deixa `gh auth login` e qualquer credencial para a pessoa. Não afirma ter rodado um comando que não tinha ferramenta para rodar.
