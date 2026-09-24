# Montar um vault com o brain-kit

Hoje é {{today}}. Vault: {{vault}}.
Rode o kit com: {{kit}}

Você está ajudando a pessoa a começar um segundo cérebro com o brain-kit, ou a trazer para ele uma pasta de notas em markdown que já existe. Vá um passo de cada vez e diga o que cada comando encontrou antes de seguir.

## Conferir a máquina

1. Rode `node --version`. Precisa ser 24 ou mais novo. Se for mais antigo, pare e avise.
2. Rode `git --version` e `gh auth status`. Se o gh não estiver logado, peça para a pessoa rodar `gh auth login` no terminal dela. Nunca rode por ela, e nunca digite senha, token ou qualquer outra credencial no lugar dela.
3. Rode `{{kit}} doctor` e diga quais verificações falharam.

## Vault novo ou existente

Aqui o `init` não pergunta nada: sem um terminal, ele tira todas as respostas de um arquivo. Quem faz as perguntas é você, no chat, e quem escreve o arquivo também.

4. Faça uma pergunta só e espere a resposta: é um vault novo, ou uma pasta de notas que já existe? Se for novo, pergunte também onde ele vai ficar.
5. Peça cada resposta abaixo, uma de cada vez, esperando cada retorno, e sugira um padrão quando fizer sentido:
   - `lang`: `pt-BR` ou `en`;
   - `name`: o primeiro nome da pessoa, e `handle`: um identificador curto em minúsculas, como `ana`;
   - `title`: o título do vault;
   - `repo`: o repositório no GitHub no formato `dono/nome`, ou `null` se ainda não existe;
   - `private`: tem que ser `true`; o kit recusa um vault cujo repositório não vai ser privado;
   - `timezone`: um fuso IANA, como `America/Sao_Paulo`;
   - `email` é opcional (`null` serve). Deixe `commit` de fora: o primeiro commit é da pessoa.
6. Grave as respostas como um objeto JSON num arquivo dentro de um diretório temporário, fora do vault, por exemplo `{"lang": "pt-BR", "name": "Ana", "handle": "ana", "title": "Cérebro da Ana", "repo": null, "private": true, "timezone": "America/Sao_Paulo", "email": null}`. Mostre o arquivo para a pessoa antes de rodar qualquer coisa.
7. Vault novo: rode `{{kit}} init <dir> --from-answers <arquivo>`.
8. Vault existente: antes, explique o que a adoção grava. Ela só grava `brain-kit.config.json` e `.brain-kit/manifest.json` no vault, e nenhuma nota é movida, renomeada ou reescrita. Ela também instala a trava de push: grava `.githooks/pre-push` no vault e configura `core.hooksPath` no git do repositório, a não ser que a pessoa já tenha um hook próprio ou um `core.hooksPath` apontando para outro lugar; nesse caso deixa tudo exatamente como está e imprime a linha para acrescentar a trava ao hook dela. Com `--no-hook`, a trava fica de fora. Depois rode `{{kit}} init --adopt <dir> --from-answers <arquivo>`.
9. Apague o arquivo de respostas quando o `init` terminar. Use `--yes` no lugar do arquivo só se a pessoa aceitar explicitamente todos os padrões.

## Repositório

10. Recomende um repositório privado no GitHub, por exemplo `gh repo create <nome> --private --source <dir>`. Explique o motivo: o vault guarda notas sobre pessoas, e um repositório público deixa tudo isso à vista de qualquer um. Deixe a pessoa escolher o nome e só crie depois que ela confirmar.

## Registrar e fechar

11. Dentro do vault, rode `{{kit}} machine register`, para esta máquina saber onde o vault mora. Logo depois do `init`, ele avisa que o vault já está registrado e não há nada a fazer: isso é esperado, não é problema.
12. Feche com `{{kit}} doctor`. Diga com todas as letras quais verificações ainda falham e o que a pessoa precisa fazer em cada uma. Não dê a instalação por concluída enquanto alguma falhar.
