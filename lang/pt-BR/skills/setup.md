# Montar um vault com o brain-kit

Hoje é {{today}}. Vault: {{vault}}.
Rode o kit com: {{kit}}

Você está ajudando a pessoa a começar um segundo cérebro com o brain-kit, ou a trazer para ele uma pasta de notas em markdown que já existe. Vá um passo de cada vez e diga o que cada comando encontrou antes de seguir.

## Conferir a máquina

1. Rode `node --version`. Precisa ser 24 ou mais novo. Se for mais antigo, pare e avise.
2. Rode `git --version` e `gh auth status`. Se o gh não estiver logado, peça para a pessoa rodar `gh auth login` no terminal dela. Nunca rode por ela, e nunca digite senha, token ou qualquer outra credencial no lugar dela.
3. Rode `{{kit}} doctor` e diga quais verificações falharam.

## Vault novo ou existente

4. Faça uma pergunta só e espere a resposta: é um vault novo, ou uma pasta de notas que já existe?
5. Vault novo: pergunte onde ele vai ficar e rode `{{kit}} init <dir>`. O comando faz as próprias perguntas, uma de cada vez; repasse cada uma para a pessoa e a resposta dela de volta, sem responder por ela.
6. Vault existente: antes de rodar qualquer coisa, explique que adotar só grava no vault a configuração e o manifesto do kit (e a trava de push dentro do `.git`, a não ser que ela passe `--no-hook`), e que nenhuma nota é movida, renomeada ou reescrita. Depois rode `{{kit}} init --adopt <dir>`.

## Repositório

7. Recomende um repositório privado no GitHub, por exemplo `gh repo create <nome> --private --source <dir>`. Explique o motivo: o vault guarda notas sobre pessoas, e um repositório público deixa tudo isso à vista de qualquer um. Deixe a pessoa escolher o nome e só crie depois que ela confirmar.

## Registrar e fechar

8. Dentro do vault, rode `{{kit}} machine register`, para esta máquina saber onde o vault mora.
9. Feche com `{{kit}} doctor`. Diga com todas as letras quais verificações ainda falham e o que a pessoa precisa fazer em cada uma. Não dê a instalação por concluída enquanto alguma falhar.
