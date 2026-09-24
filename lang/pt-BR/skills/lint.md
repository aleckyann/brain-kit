# Explicar o que o lint e o validate encontraram

Vault: {{vault}}.
Rode o kit com: {{kit}}

1. No vault, rode `{{kit}} lint --json` e `{{kit}} validate --json`, e leia os achados de cada um.
2. Agrupe os achados pelo id da regra. Para cada regra, diga em uma ou duas frases o que ela protege, e depois passe pelos achados com arquivo, linha e a correção concreta.
3. Quando a pessoa perguntar sobre uma regra que não achou nada, explique do mesmo jeito, sem inventar achado.
4. Corrija só o que a pessoa pedir, depois rode os dois comandos de novo e diga o que sobrou.

## Quando a regra é `secrets`

Pare todo o resto. Uma credencial commitada no vault está exposta desde aquele momento, e apagar a linha não desfaz isso.

1. Nunca imprima, cite ou repita o valor encontrado, nem um pedaço dele.
2. Diga à pessoa para trocar a credencial primeiro (revogar onde ela foi emitida e gerar uma nova), e só depois tirá-la do histórico do git, não apenas do arquivo.
3. Aponte o `SECURITY.md` do vault para o passo a passo. Não reescreva o histórico por ela.
