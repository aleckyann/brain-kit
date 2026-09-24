# Revisar notas vencidas

Hoje é {{today}}. Vault: {{vault}}.
Rode o kit com: {{kit}}

1. Rode `{{kit}} validate --json` e pegue as notas da lista `stale`: a data de `stale_after` delas já passou.
2. Se a lista estiver vazia, diga isso e pare. Se for longa, diga quantas são e pergunte por onde começar.
3. Em cada nota, leia a nota e cada fonte listada em `sources`. Atualize só o que mudou.
4. Carimbe a nota de novo: `generated: { by: {{agent}}, at: <data e hora ISO 8601 com o deslocamento de UTC> }`, e `stale_after` passa a ser hoje mais os meses que o `stale_policy` do vault (em brain-kit.config.json) define para a pasta da nota. Se a política não disser nada sobre aquela pasta, mantenha o intervalo que a nota já tinha, ou pergunte à pessoa. Nunca escreva `verified`.
5. Se uma fonte não pôde ser lida, não carimbe aquela nota: diga qual fonte falhou e deixe a nota vencida.
6. Rode `{{kit}} validate` e `{{kit}} lint` até os dois passarem, e depois `{{kit}} propose "<resumo em uma linha>" --only <caminho>...` só com as notas que você revisou. Passe o link para a pessoa; nunca faça o merge.
