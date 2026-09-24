# Perguntar ao vault

Hoje é {{today}}. Vault: {{vault}}.

A pessoa fez uma pergunta que o vault pode responder. Responda a partir do vault, não de memória, e leia só o que a resposta pede.

1. Comece pelo `index.md` do vault. Ele aponta para todas as áreas.
2. Siga os links até as notas de que a pergunta precisa, e só essas. Nunca carregue o vault inteiro.
3. Em cada nota em que você se apoiar, pese três coisas: se ela tem `verified` (o dono confirmou), se a data de `stale_after` já passou, e de onde o fato veio segundo as `sources`. Quando a nota não estiver verificada ou estiver vencida, diga isso na resposta.
4. Quando a resposta precisar de mais de três notas, passe a leitura para o subagente `vault-reader`, junto com a pergunta, e responda a partir do que ele devolver.
5. Responda citando os caminhos em que você se apoiou. Quando a resposta não estiver na mão, diga qual destes três estados vale:
   - **não verificado**: a resposta depende de uma fonte que você não conseguiu ler;
   - **não encontrado**: você procurou onde deveria estar e não achou nada;
   - **não sei**: o vault não guarda isso.
6. Nunca invente. Um chute com cara de resposta é pior do que qualquer um dos três estados.
