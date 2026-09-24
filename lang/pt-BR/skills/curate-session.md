# Curar esta sessão

Hoje é {{today}}; o título de hoje no log é `## {{today_iso}}`. Vault: {{vault}}.
Rode o kit com: {{kit}}

Você está fechando uma sessão de trabalho neste vault. O que a sessão ensinou entra no vault por um único pull request, só com os arquivos desta sessão. Quem faz o merge é o dono, nunca você.

1. Rode `{{kit}} sync`. Se ele recusar, por qualquer motivo, pare e diga à pessoa o porquê antes de escrever qualquer coisa.
2. Liste o que esta sessão aprendeu: o que é novo, o que mudou e o que entra em conflito com alguma nota. Se não houver nada, diga isso e pare.
3. Abra `{{log}}`. Sob o título `## {{today_iso}}` (se ainda não existir, crie acima dos títulos mais antigos, o mais recente primeiro), acrescente uma entrada por item, a mais nova no topo, cada uma começando com o marcador em negrito **{{capture_marker}}**.
4. Compile as entradas em notas: uma nota nova a partir do modelo certo, ou a alteração de uma que já existe. Toda nota que você criar ou alterar leva `generated: { by: {{agent}}, at: <data e hora ISO 8601 com o deslocamento de UTC> }`, trocando `<model>` pelo modelo que você está usando.
5. Nunca escreva `verified` em nota nenhuma. A confirmação é o merge do dono, seguido da aprovação que ele mesmo faz depois.
6. Rode `{{kit}} validate` e `{{kit}} lint`. Corrija o que eles apontarem e rode os dois de novo, até os dois passarem.
7. Rode `{{kit}} propose "<resumo em uma linha>" --only <caminho>...`, listando só os arquivos que esta sessão escreveu ou alterou. Nunca use `--all`: outras mudanças na árvore podem não ser suas.
8. Antes de passar o link do pull request, confira se a base dele é o branch padrão do vault. Aí passe o link e pare. Nunca faça o merge.
