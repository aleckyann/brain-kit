# brain-kit

O brain-kit mantém um segundo cérebro em markdown puro (arquivos de texto), no Open Knowledge
Format (OKF) v0.2: um agente de IA o lê por um índice e o alimenta todo dia a partir do seu
próprio trabalho (as suas sessões do Claude Code, a agenda, as notas de reunião). O agente só
altera o cérebro por pull request, um pedido de mudança que você lê no GitHub, e o seu merge,
o clique que aprova o pedido, é a aprovação e a verificação.

> **Comece aqui.** Com o Node.js 22 ou mais novo (o 24 LTS é o recomendado), o git, o `gh` (o aplicativo
> do GitHub para o terminal), o Claude Code e uma conta no GitHub já prontos, o caminho até o seu primeiro
> pull request leva cerca de 30 minutos na primeira vez: uns 10 de leitura e 21 nos passos abaixo. São
> estimativas, não uma promessa. O detalhe de cada passo está em [Seu primeiro vault](#seu-primeiro-vault).
>
> 1. Instale o kit e o plugin colando o [trecho de instalação](#instalando-uma-versão-fixa) no terminal (2 min).
> 2. Entre no GitHub com `gh auth login` ([passo 2](#passo-2), 3 min).
> 3. Confira a máquina com `brain-kit doctor`, fora de qualquer vault ([passo 3](#passo-3), 1 min).
> 4. Crie o vault com `brain-kit init ~/my-brain` ([passo 4](#passo-4), 3 min).
> 5. Faça o primeiro commit com `git add -A` e `git commit` ([passo 5](#passo-5), 3 min).
> 6. Envie para o GitHub com `gh repo create my-brain --private --source . --push` ([passo 6](#passo-6), 1 min).
> 7. Abra o primeiro pull request com `brain-kit propose` ([passos 7 a 10](#passo-7), 8 min) e aprove-o no GitHub ([passo 11](#passo-11)).

**Palavras que você vai ver**

| Palavra | O que quer dizer |
|---|---|
| terminal | a janela onde você digita comandos |
| PATH | a lista de pastas onde o terminal procura os comandos que você digita |
| repositório | uma pasta cujo histórico o git guarda; o GitHub guarda uma cópia dela na internet |
| branch | uma linha de trabalho do repositório; a principal costuma se chamar `main` ou `master` |
| commit | um ponto salvo no histórico, com uma mensagem que diz o que mudou |
| pull request | um pedido para juntar mudanças ao branch principal, que você lê e aprova no GitHub |
| merge | aprovar um pull request: as mudanças dele entram no branch principal |
| vault | a pasta das suas notas (o seu segundo cérebro), que é um repositório |
| trava de push | a conferência que roda antes de você enviar (fazer push) o vault ao GitHub e barra senhas e chaves esquecidas |
| hook | um programa que roda sozinho quando algo acontece, como antes de um envio ao GitHub |
| skill | uma instrução pronta que o Claude Code segue quando você a pede, como a `capture` |
| plugin, marketplace | o plugin acrescenta skills e hooks ao Claude Code; o marketplace é a lista de onde ele os instala |

## Requisitos

Para chegar ao primeiro pull request você precisa de Node.js 22 ou mais novo (o 24 LTS é o
recomendado), com o npm dele (`node --version` mostra qual você tem), git, o `gh` (o aplicativo
do GitHub para o terminal) com o login feito (`gh auth login`), o Claude Code e uma conta no
GitHub. As rodadas agendadas do curador, as fontes de agenda e de notas de reunião e o
briefing com horário são opcionais e ficam para depois:
[O curador agendado](#o-curador-agendado) e o [docs/scheduling.md](docs/scheduling.md) os
apresentam, com o que cada um exige.

## Instalando uma versão fixa

Um vault do qual você depende deve rodar uma versão fixa do kit, e não o que o branch
padrão tiver hoje. Toda versão a partir da 0.0.2 é uma tag do git (um marcador de versão), e a
tag mais recente é a que se instala. A lista das versões, e o que cada uma fez, está no
[CHANGELOG](CHANGELOG.md) e na página de Releases do repositório. O trecho abaixo faz tudo de
uma vez: baixa o repositório, descobre a tag mais recente (a segunda linha, então nada abaixo
cita uma versão), empacota essa tag num arquivo `.tgz`, instala o `brain-kit` a partir dele e
instala o plugin. Cole-o inteiro no terminal:

```bash
git clone https://github.com/aleckyann/brain-kit.git
TAG=$(git -C brain-kit describe --tags --abbrev=0)
mkdir -p ~/.local/share/brain-kit/$TAG
git -C brain-kit archive $TAG | tar -x -C ~/.local/share/brain-kit/$TAG
cd ~/.local/share/brain-kit/$TAG && npm pack --silent && npm i -g ./second-brain-kit-${TAG#v}.tgz
rm -f ~/.local/share/brain-kit/$TAG/second-brain-kit-${TAG#v}.tgz
claude plugin marketplace add ~/.local/share/brain-kit/$TAG
claude plugin install brain-kit@brain-kit --scope user
```

O `brain-kit --version` imprime a versão que você instalou. O trecho já apaga o arquivo
`.tgz` que ele mesmo criou, para não deixar uma cópia dele dentro da pasta do plugin. A pasta
`brain-kit` que a primeira linha baixou (ela fica na pasta onde você colou o trecho) não é
mais usada e pode ser apagada. Já a pasta `~/.local/share/brain-kit/`, que o trecho cria,
**não pode ser apagada**: é dela que o Claude Code carrega o plugin.

Onde o npm aceita baixar direto do git, `npm i -g github:aleckyann/brain-kit#<tag>` instala o
kit de uma tag, sozinho; onde ele recusa (com o erro `EALLOWGIT`), o trecho empacota a tag por
você, instala o `.tgz` e guarda a cópia desempacotada para o plugin. `claude plugin marketplace add aleckyann/brain-kit`
segue, em vez disso, o branch padrão do repositório. O CI de um vault pode fixar o kit do mesmo
jeito, baixando-o no commit da tag ao lado do vault.

### Se aparecer `EACCES`

`EACCES` quer dizer "permissão negada": o npm tentou instalar numa pasta do sistema, onde você
não pode gravar. Isso costuma acontecer quando o Node veio do instalador do sistema; quem
instalou o Node com o nvm não vê este erro e pode pular este bloco. Evite o `sudo` (rodar como
administrador), que costuma deixar arquivos do administrador na sua pasta e causar mais erros
de permissão depois: mande o npm instalar numa pasta sua. Rode uma vez:

```bash
npm config set prefix ~/.local
```

Agora ponha essa pasta (`~/.local/bin`) no PATH, a lista de pastas onde o terminal procura os
comandos que você digita. Use a linha do seu terminal (o Linux costuma usar o bash e o macOS,
o zsh; na dúvida, rode as duas):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Feche o terminal e abra outro (é assim que o PATH novo passa a valer) e cole o trecho de
instalação de novo: a primeira linha pode reclamar que a pasta `brain-kit` já existe, e as do
plugin vão dizer que ele já está instalado; está tudo certo. Confira:

```bash
brain-kit --version
```

## Seu primeiro vault

De uma máquina com os requisitos acima até o seu primeiro pull request, em ordem (o quadro
"Comece aqui", no alto da página, resume os mesmos passos, com o tempo de cada um). Três dos
comandos, marcados com "(o `init` imprime isto no fim)", são os que o próprio `init` imprime
quando termina.

1. Instale o kit e o plugin: cole no terminal o trecho inteiro de
   [Instalando uma versão fixa](#instalando-uma-versão-fixa). As seis primeiras linhas
   instalam o kit e põem o `brain-kit` no seu PATH, onde a trava de push do vault também o
   procura; as duas últimas instalam o plugin do Claude Code. Se aparecer `EACCES`, o bloco
   [Se aparecer `EACCES`](#se-aparecer-eacces), logo abaixo do trecho, resolve.
2. <a id="passo-2"></a>Entre no GitHub, no seu próprio terminal (o `init` imprime isto no
   fim). O `propose` abre os pull requests dele com o `gh`, e o `doctor` falha para um `gh`
   sem login. O `gh` faz algumas perguntas e abre o navegador para você confirmar um código:

   ```bash
   gh auth login
   ```

3. <a id="passo-3"></a>Confira a máquina:

   ```bash
   brain-kit doctor
   ```

   Fora de um vault (você ainda não tem nenhum), o `doctor` confere só a máquina: o Node, o
   git, o `gh` e o login dele, e o Claude Code. Está tudo certo quando a linha que começa com
   `doctor:` termina em `0 falha(s)`. A mensagem "nenhum vault brain-kit encontrado", que vem
   logo depois, é esperada: você ainda não tem vault. Uma linha `falha` diz o que rodar para
   corrigi-la. Como ainda não há vault, ele usa o idioma do seu sistema: se este estiver em
   inglês, as palavras saem como `fail` e `warn`, e a linha termina em `0 fail`.
4. <a id="passo-4"></a>Crie o vault numa pasta nova ou vazia:

   ```bash
   brain-kit init ~/my-brain
   ```

   Ele faz sete perguntas, uma de cada vez, e precisa de um terminal para fazê-las (se você
   tentar passar as respostas por outro comando, ele recusa sem escrever nada). Na pergunta
   "Apelido curto" (o nome curto que assina as suas aprovações), aceite a sugestão: é só
   apertar Enter. Onde não há terminal, `--from-answers <arquivo>` lê as respostas de um
   arquivo JSON e `--yes` aceita todos os padrões. O `init` escreve o esqueleto e a trava de
   push, roda `validate` e `lint` sobre ele (conferem se o vault segue o formato e se está
   saudável), diz numa linha só que não achou nada e não faz commit. A pergunta do
   repositório só registra um nome: o `init` não cria repositório nem remoto.
5. <a id="passo-5"></a>Faça o primeiro commit:

   ```bash
   cd ~/my-brain
   git add -A
   git commit -m "Inicia o vault"
   ```

   O git guarda quem fez cada commit, então precisa saber quem você é. Se ele recusar, dizendo
   `Author identity unknown` ou `Please tell me who you are`, rode estes dois comandos, com o
   seu nome e o seu e-mail no lugar dos de exemplo (o `example.com` é só um exemplo), e repita
   o `git commit`:

   ```bash
   git config --global user.name "Seu Nome"
   git config --global user.email "voce@example.com"
   ```

6. <a id="passo-6"></a>Crie o repositório no GitHub e envie o vault, num comando só (o `init`
   imprime isto no fim):

   ```bash
   gh repo create my-brain --private --source . --push
   ```

   O repositório é privado porque o vault guarda notas sobre pessoas, e um repositório
   público as deixa à vista de qualquer um. O comando faz o push (`--push`) porque sem ele o
   remoto (a cópia no GitHub) fica vazio, não há branch padrão nele e o `propose` não consegue
   funcionar. O push roda a trava de push do vault (`validate`, `lint` e uma busca por senhas
   e chaves), então um vault que falhe neles não é publicado.
7. <a id="passo-7"></a>Confira a máquina e o vault:

   ```bash
   brain-kit doctor
   ```

   A saída mostra só os avisos e as falhas, com a contagem das linhas `ok`
   (`brain-kit doctor --verbose` lista todas). Um resultado saudável não tem nenhuma linha
   `falha`: a última linha termina em `0 falha(s)`. Neste ponto, linhas `aviso` sobre o
   curador agendado (`watermark`, o último dia lido; `last-run`, a última rodada; `schedule`,
   o agendamento; `notify`, o comando de notificação; e `briefing`) estão bem: você ainda não
   configurou nenhum, e o [docs/scheduling.md](docs/scheduling.md) trata disso quando você
   quiser que uma rodada rode sozinha, num horário. Uma `falha` diz o que rodar para
   corrigi-la; a do `gh` diz `gh auth login`.
8. Abra o Claude Code dentro da pasta do vault (`cd ~/my-brain`, se você abriu outro
   terminal; o `init` imprime isto no fim):

   ```bash
   claude
   ```

   Se o Claude Code perguntar se você confia nesta pasta, responda que sim. Com o plugin
   instalado, as nove skills e os hooks `Stop` e `SessionStart` dele funcionam nesta pasta;
   [O plugin do Claude Code](#o-plugin-do-claude-code) diz o que cada um faz.
9. Escreva um fato no log do vault, `memoria/log.md` (`memory/log.md` num vault em inglês).
   Ou conte algo novo ao Claude, como "Registre no log que comecei este vault hoje" (a
   skill `capture` escreve a entrada datada), ou acrescente você mesmo: um título
   `## AAAA-MM-DD` com a data de hoje e, embaixo, uma linha que começa com `**Captura**`
   (`**Capture**` num vault em inglês).
10. Abra o pull request. O hook `Stop` roda quando o Claude termina uma resposta: ele vê o
    arquivo alterado e pede ao Claude que valide, rode o lint e proponha, o que a skill
    `curate-session` também faz quando pedida. Para fazer você mesmo:

    ```bash
    brain-kit propose "Primeira captura" --only memoria/log.md
    ```

    `--only` nomeia exatamente os arquivos a propor, e o `propose` nunca mexe no seu branch
    nem nos seus arquivos. Acrescente `--dry` antes para ver o plano: ele recusa o que a
    execução de verdade recusaria (sem `gh`, sem login, sem `origin`, o endereço do repositório
    no GitHub, ou com o branch padrão ainda não enviado). Deixe o arquivo alterado sem commit
    até o pull request ser mergeado (passo 11): o `propose` monta o commit dele à parte, e
    fazer commit do mesmo arquivo no seu branch padrão faz o `sync` recusar depois, dizendo que
    os branches divergiram.
11. <a id="passo-11"></a>Faça o merge do pull request no GitHub: o seu merge é a aprovação, e
    a única forma de o vault mudar. Depois o `brain-kit sync` troca o arquivo que você deixou
    sem commit pelo mergeado e deixa o seu branch local em dia com o remoto, e o
    `brain-kit verify --pr <número>` carimba `verified` (verificada) nas notas que esse pull
    request alterou (a skill `approve` faz o mesmo). O log não é uma nota: para este primeiro
    pull request, que mudou só o log, o `verify` termina dizendo "nada a carimbar, e nada foi
    escrito", sem erro; isso é esperado.

A partir daqui, [O curador agendado](#o-curador-agendado) alimenta o vault com as suas
sessões do Claude Code sem você pedir, e [O briefing matinal](#o-briefing-matinal) diz
toda manhã onde ele está.

**Se travar**

- `EACCES` ao instalar (o npm não pode gravar onde queria): use os comandos de [Se aparecer `EACCES`](#se-aparecer-eacces).
- O `gh` pede login: rode `gh auth login` ([passo 2](#passo-2)) e tente de novo.
- O `propose` pede o primeiro commit ([passo 5](#passo-5)) ou o `origin`, o endereço do GitHub ([passo 6](#passo-6)); se ele diz "Envie o branch padrão primeiro", o repositório já existe: rode `git push -u origin HEAD` (repetir o `gh repo create` falha).
- `command not found` (ou `comando não encontrado`) para o `brain-kit` depois de instalar: o npm pode ter recusado no meio da saída, que termina em "Successfully installed" mesmo assim; siga o bloco [Se aparecer `EACCES`](#se-aparecer-eacces) inteiro, do começo.
- O `doctor` diz `falha` no `gh-auth`: o login do `gh` venceu ou nunca foi feito; rode o comando que a linha mostra, `gh auth login --hostname github.com`.
- Uma senha ou chave apareceu no vault: pare e siga o [docs/incident-response.md](docs/incident-response.md) (em inglês).

## O mesmo vault em uma segunda máquina

Um vault que você já configurou abre em outra máquina com um clone. O que o clone não traz é o
estado daquela máquina (o `machine.json`, as marcas de leitura e os logs), que fica fora do
vault e nunca vai para o git. Na segunda máquina, instale o kit e o plugin e entre no GitHub
como nos passos 1 e 2 de [Seu primeiro vault](#seu-primeiro-vault); depois, nesta ordem:

1. Clone o vault (troque `my-brain` pelo nome que você deu ao repositório):

   ```bash
   gh repo clone my-brain ~/my-brain
   cd ~/my-brain
   ```

2. Registre a máquina. O `machine register --new` escreve o `machine.json` dela, fora do
   vault, e não toca em nenhum arquivo do vault:

   ```bash
   brain-kit machine register --new
   ```

3. Dê ao clone a trava de push do vault (o git não guarda a própria configuração, então um
   clone nasce sem ela):

   ```bash
   git config core.hooksPath .githooks
   ```

4. Confira. O resultado saudável não tem nenhuma linha `falha`:

   ```bash
   brain-kit doctor
   ```

5. Só na máquina que vai rodar as rodadas do curador, instale o agendamento:

   ```bash
   brain-kit schedule install
   ```

Deixe só uma máquina rodar as rodadas do curador: o estado é por máquina, então duas máquinas
agendadas proporiam, cada uma, o mesmo dia. Na outra, use o vault à mão.

O `brain-kit machine register --new` imprime estes passos também, mas com o `doctor` antes do
`git config`: se você pular o passo 3, o `doctor` falha em `hooks-path` e diz o mesmo comando.

Um vault criado por esta versão do `init` não precisa de edição nenhuma na segunda máquina,
mesmo com o clone em outra pasta: ele lista o próprio projeto como `{vault}` em
`include_projects`, que vale para a pasta do vault em cada máquina.

Um vault criado antes da 0.0.9 lista o projeto pelo nome que ele tinha na primeira máquina, e o
`doctor` da segunda dá `falha include-projects`. Não ponha no `brain-kit.config.json` o nome do
projeto desta máquina para fazer o `doctor` calar: o arquivo é o mesmo nas duas máquinas, e a
primeira deixaria de ler as próprias sessões. Em vez disso, troque o nome que está em
`sources.transcripts.include_projects` por `"{vault}"`, proponha a mudança com
`brain-kit propose "Usa {vault}" --only brain-kit.config.json`, faça o merge no GitHub e rode
`brain-kit sync` nas duas máquinas; o `doctor` passa a terminar em `0 falha(s)`. O
[docs/scheduling.md](docs/scheduling.md#before-the-first-round) (em inglês) explica isso na
seção "Before the first round", e traz os
[detalhes da segunda máquina](docs/scheduling.md#the-same-vault-on-a-second-machine), inclusive
como mover as rodadas de uma máquina para a outra.

## O que há no repositório

O brain-kit é um repositório que pretende ser, ao mesmo tempo:

- um pacote npm (o formato em que o Node distribui programas), `second-brain-kit`, com um
  único executável, `brain-kit`. Hoje ele cria um vault ou adota um existente, instala a trava
  de push dele, mantém atualizados os arquivos do próprio kit, confere a máquina com o
  `doctor`, valida e confere a saúde (o `lint`) de um vault, roda o ciclo de pull request
  (`sync`, `propose`, `verify`) e roda o curador agendado (`curate`, `watermark`, `schedule`)
  e os fatos e a fila de perguntas do briefing matinal (`preflight`, `questions`);
- um plugin do Claude Code (nove skills, os hooks Stop e SessionStart, um subagente
  somente leitura) que chama o mesmo motor;
- um marketplace de um plugin só, para que `claude plugin marketplace add aleckyann/brain-kit`
  seguido de `claude plugin install brain-kit@brain-kit` o instale.

O registro do npm recusou o nome `brain-kit`: já existe lá um pacote sem relação chamado
`brainkit`, e os dois foram considerados parecidos demais. Por isso o pacote é publicado
como `second-brain-kit`, enquanto o repositório, o plugin, o marketplace e o comando que
você digita depois se chamam todos `brain-kit`.

O motor é Node.js sem nenhuma dependência, de runtime ou de desenvolvimento, e roda no
Node.js 22 e no 24 (os dois são testados a cada mudança). O vault que ele gera é seu:
arquivos markdown, com um cabeçalho (o frontmatter, em YAML) em cada nota, e um arquivo de
configuração só com dados, nada mais.

## O que funciona hoje

Um vault é um diretório com um `brain-kit.config.json` e um `index.md` na raiz; os comandos
recebem o caminho dele, ou o encontram subindo a partir do diretório atual. Os comandos
abaixo supõem o `brain-kit` no seu PATH (veja
[Instalando uma versão fixa](#instalando-uma-versão-fixa)); para rodar um a partir de um
clone sem instalar, troque `brain-kit` por `node <clone>/bin/brain-kit.mjs`.

```bash
brain-kit init caminho/do/vault-novo
brain-kit init --adopt caminho/do/vault-existente
brain-kit update caminho/do/vault
brain-kit doctor caminho/do/vault
brain-kit validate caminho/do/vault
brain-kit lint caminho/do/vault
brain-kit sync caminho/do/vault
brain-kit propose "resumo" --only notas/alterada.md
brain-kit verify --pr 12
brain-kit curate caminho/do/vault
brain-kit watermark show caminho/do/vault
brain-kit schedule install caminho/do/vault
brain-kit preflight caminho/do/vault
brain-kit questions list caminho/do/vault
brain-kit schedule install --job briefing caminho/do/vault
```

O `init` cria um vault novo num diretório vazio ou novo, em inglês ou português: o
esqueleto, a configuração, um `.gitignore`, a trava de push (`.githooks/pre-push`, com o
`core.hooksPath` apontando para ele), um manifesto do que o kit escreveu, um repositório
git, e o `machine.json` num diretório de estado fora do vault. Ele faz uma pergunta por
vez, o que exige um terminal; `--yes` (todos os padrões, listados) ou
`--from-answers <arquivo>` (um objeto JSON) respondem por você onde não há um, e ele nunca
faz o primeiro commit a menos que isso seja pedido.

Um vault fala o idioma escolhido para ele no `init`, com a primeira pergunta ou com
`init --lang en|pt-BR`: o `validate`, o `lint`, o `doctor`, as skills e os hooks o usam. Todo o resto
que o kit imprime, e todo comando fora de um vault, tira o idioma de `BRAIN_KIT_LANG` (`en`
ou `pt-BR`) quando ela está definida, senão da primeira entre `LC_ALL`, `LC_MESSAGES` e
`LANG` que estiver: um valor que começa com `pt` é português, qualquer outro é inglês.

O `init --adopt` traz um vault existente para o kit. O vault precisa já ser um repositório
git (escreva o `.gitignore` dele e depois rode `git init`); uma pasta que não é um é
recusada sem nada escrito. Ele deduz a configuração das notas que o git publicaria (uma
pasta ou nota que o git ignora não contribui com nada) e mostra cada dedução,
escreve a configuração e um manifesto que registra como seus, só pelo caminho, os arquivos
que o git publicaria (um arquivo que o git ignora nunca é registrado, e nenhum hash do seu
conteúdo é guardado), e instala a trava de push. Um hook seu, ou um `core.hooksPath` apontando para outro lugar, fica
exatamente como está, e o adopt mostra a linha que acrescenta a trava a ele. `--no-hook`
pula a trava. Ele nunca muda uma nota e nunca faz commit.

O `update` atualiza por checksum os arquivos que o kit gerencia (os arquivos de contrato
da raiz, o `.gitignore` e o hook): um que você não editou é substituído, um que você
editou nunca é sobrescrito, e uma versão mais nova é escrita ao lado como
`<nome>.brain-kit-new`. O `update --install-hook` instala a trava de push num vault que não
o tem, com o mesmo cuidado com um hook seu.

O `doctor` informa, verificação por verificação, se esta máquina e este vault estão
prontos: Node e git, a trava e o `core.hooksPath`, o `brain-kit` no PATH, a configuração, o
manifesto, o `machine.json` e o diretório de estado dele, a versão do kit, o `gh`, o
`claude`, e o `node_modules/` no `.gitignore`; e, para o curador agendado, se o `claude` é
a CLI de verdade e conhece todas as flags que isolam uma rodada, os projetos de onde vêm os
transcripts, quantos dias de atraso tem a marca d'água de cada fonte, a última rodada (uma
rodada que sai com 0 em segundos sem nenhum turno do modelo é apontada como morta), o timer
e os próximos disparos, e se uma rodada que falha chega até você ou fica só no log; e,
desde a fase 3, se o lint tem palavras-chave de privacidade para recusar nas linhas
acrescentadas, tudo o que uma rodada pode alcançar além do vault, e cada fonte por
conector: desligada ou ligada, o estado que a última rodada viu com a data dela, um
prefixo de ferramenta que não confere, agendas de outras pessoas sem o consentimento
registrado, e uma regra de usuário que recusa o modo com conectores. O `doctor --probe`
pergunta agora à CLI o estado de cada conector, sem rodada. Desde a fase 4 ele confere
também o briefing matinal: as assinaturas, os blocos, a fila de perguntas e a tarefa no
aplicativo para desktop. Cada falha nomeia o comando que a corrige. Por padrão a saída mostra só os
avisos e as falhas, com a contagem das linhas `ok`; `--verbose` lista todas.

O `validate` confere o vault contra o OKF v0.2 e reporta duas réguas separadas: a
conformidade do próprio formato e as regras da casa do vault, que são mais estritas de
propósito. Um vault pode estar conforme ao formato e ainda assim se afastar das próprias
regras, e o relatório diz qual é qual. `--json` gera saída legível por máquina e
`--only-problems` deixa de fora os grupos que não acharam nada.

O `lint` confere a saúde do vault com oito regras:

| Regra | O que confere |
|---|---|
| `index-completeness` | todo diretório com notas tem índice, e o índice raiz aponta para todo diretório de primeiro nível |
| `orphans` | toda nota pode ser alcançada seguindo links a partir do índice raiz |
| `columns` | as tabelas usam os cabeçalhos de coluna que a configuração declara |
| `tables` | forma da tabela: a linha em branco antes dela, linhas duplicadas, células longas demais |
| `style` | caracteres que a configuração proíbe, nas linhas que uma mudança acrescentou |
| `secrets` | formatos de credencial e padrões configurados, em todo arquivo que um push poderia publicar, incluindo arquivos com ponto como o `.env` |
| `privacy` | notas confidenciais ficam em diretórios confidenciais e não recebem link de diretórios compartilhados, e uma linha que uma mudança acrescenta não tem nenhum dos termos de `privacy.third_party_keywords` (a saúde ou a vida privada de outra pessoa) |
| `attribution` | as fontes de uma nota e as notas de rodapé dela se ancoram umas nas outras |

`--rule` restringe a rodada às regras nomeadas, `--base` escolhe o que conta como a
mudança (`auto`, `worktree`, `merge-base` ou `all`), e `--json` gera saída legível por
máquina. A regra `secrets` ignora o `--base` e sempre lê tudo o que um push poderia
publicar, porque uma credencial que já está lá é o achado de que um vault novo mais precisa.

O `sync` deixa o branch padrão em dia com o remoto antes de qualquer escrita: avança um
branch que está atrás e recusa um que divergiu. O `propose` transforma os caminhos que você
lista num pull request contra o branch padrão sem mexer no HEAD, no índice nem na árvore de
trabalho, então arquivos de outra sessão nunca entram de carona; sem o `gh`, ou quando o
pull request não pode ser aberto contra a base certa, ele sai com 3, deixa o commit feito e
diz o que rodar. O `verify` é o comando do dono depois do merge: carimba `verified` (verificada) nas
notas que o pull request mergeado alterou e faz o commit com a identidade do próprio dono.
O `machine` mostra e edita o `machine.json` local da máquina.

## O curador agendado

As rodadas agendadas são opcionais: o primeiro pull request não precisa delas. Linux é a
plataforma de referência para agendamento (timers de usuário do systemd, que precisam de
`loginctl enable-linger` para rodar com você deslogado); as entradas de macOS (launchd) e cron
são geradas e testadas sem que a suíte de testes as instale; Windows fica fora do escopo de
agendamento.

O `curate` roda uma rodada: lê as sessões do Claude Code dos projetos que a sua
configuração lista, escolhidas pelo horário das mensagens, e as entrega a um modelo que só
consegue agir pelos próprios `validate`, `lint` e `propose` do kit. A rodada termina num
pull request contra o seu vault. O modelo roda isolado das suas próprias configurações do
Claude Code: nenhum arquivo de configuração seu ou do projeto é carregado, nenhum hook,
nenhum servidor MCP, nenhuma skill e nenhuma ferramenta nativa além das sete de que ele
precisa; ele lê só o vault e um extrato de cada transcript que a rodada lista, e tudo o que as regras da
própria rodada não permitem é negado. A rodada confere o isolamento pelo primeiro evento
da CLI e para o modelo se ele não se confirmar. Os passos rodam numa ordem fixa e testada (lock, rede, sync, e só então a
configuração já sincronizada), e toda forma de uma rodada falhar termina com uma saída
diferente de zero, um motivo no `last-run.json` e no log, e o seu comando de notificação. O
`--dry` mostra o que uma rodada faria e o `--check` roda todos os passos até o modelo.

O `watermark` mostra e move o último dia varrido de cada fonte. Cada fonte lê os dias
seguintes à própria marca, os mais antigos primeiro e inteiros (quantos couberem em
`curate.caps.transcripts`; os demais ficam para a próxima rodada), e a marca dela só anda
quando o registro da rodada mostra a fonte lida e o modelo a informou; nenhum dia é
fechado sem ter sido lido. O `watermark import --from <arquivo>` traz a marca d'água de
uma instalação antiga que guardava uma data num arquivo próprio, como o último dia varrido
de toda fonte habilitada (ou das que `--sources` nomeia). Um vault ainda rodado por um job
antigo que segura um `flock` num arquivo pode apontar `paths.legacy_lock` do `machine.json`
para esse arquivo, e então quem escreve pelo kit e esse job nunca ficam na árvore ao mesmo
tempo. O `schedule install|uninstall|status` instala a rodada em janelas diurnas (09:30, 14:00 e
20:00 por padrão), com um nome que diz o que ela faz e sem depender de nenhum alvo de rede:
os timers de usuário do systemd são a referência, e launchd e cron também são gerados.

O [docs/scheduling.md](docs/scheduling.md) explica a rodada passo a passo, as janelas, a
marca d'água e a importação dela, a saída de uma trava legada, os códigos de saída e o que
fazer em cada um. O
[docs/security.md](docs/security.md) explica o que isola o modelo e as medições por trás
disso.

## Agenda e notas de reunião

Uma rodada também pode ler a sua agenda, pelo conector Google Calendar do claude.ai, e as
suas notas de reunião, pelo conector Google Drive do claude.ai; os dois conectores precisam
estar conectados no claude.ai e ativados para o Claude Code. As duas fontes ficam
desligadas até você ligá-las: a agenda, nomeando as agendas a ler; as notas de reunião,
copiando de um documento seu o título literal das suas notas automáticas, com os acentos.
As duas são de melhor esforço, isto é, podem falhar sem derrubar a rodada: uma rodada que não
consegue ler uma delas deixa o dia dessa fonte aberto e ainda cura e propõe o resto, e
nenhuma das duas consegue escrever nada pelo seu conector.

Para chegar aos conectores, a rodada carrega as suas configurações de usuário do Claude
Code e desliga tudo o que elas trazem além dos conectores: os seus hooks, as suas skills,
toda ferramenta nativa além do conjunto fixo, e cada regra de permissão sua, espelhada
como uma negação (uma regra que não dá para espelhar recusa esse modo, e a rodada roda só
com os transcripts). O estado de cada conector vem do primeiro evento da própria rodada:
um conector que precisa de autenticação, que falhou, que está ausente (nunca conectado, ou
desativado para o Claude Code) ou que está sem as ferramentas faz a rodada parar o modelo
antes do primeiro turno e lançar mais uma vez sem ele. O que conta como fonte lida é o
registro das chamadas que o modelo fez, nunca a palavra dele: cada agenda listada na janela
inteira, com o filtro de eventos privados e todas as páginas, e a busca pelo título
literal com o seu limite de data. Um estado que muda é avisado uma vez pelo seu comando de
notificação, e a linha de status da sessão nomeia um conector que não estava conectado na
última rodada.

A skill `seed-rituals` preenche a tabela do ritmo semanal do vault a partir da sua agenda,
na sua própria sessão, com a sua confirmação para cada linha. O
[docs/connectors.md](docs/connectors.md) explica o que cada fonte lê, como ligá-la, os
estados e o que fazer em cada um, e a política de privacidade.

## O briefing matinal

Toda manhã de dia útil, ou quando você pede, o briefing mostra, numa sessão sua, onde o
vault está: a última rodada do curador e o estado de cada fonte, o que está atrasado, o que
vence hoje e nos próximos dias, as pendências sem data, os pull requests esperando o seu
merge, as notas para revisar, os pontos cegos, o vault diante da estratégia, e as perguntas
que ele precisa que você responda. O conteúdo é o próprio `briefing.blocks` do vault,
escolhido no catálogo do kit ou escrito por você (um título, as notas a ler, a sua
instrução), e um prompt do próprio vault (`briefing.prompt`) pode trocar o prompt inteiro.

Toda data, contagem e prazo que ele traz é calculado pelo kit: o `preflight` imprime os
mesmos fatos, lendo as tabelas de pendências pelo nome da coluna e pondo cada item num
balde pela primeira data real da célula, com "sem data" como balde próprio e o que for
ambíguo nomeado junto do item. O julgamento é do modelo. O kit nunca põe no prompt o
conteúdo de um caminho em `briefing.never_read`: um caminho que ele precisa citar, como
uma nota vencida, vem marcado "(nunca lido)", e as verificações dele, como o `validate`,
leem cada nota e usam só o frontmatter dela. O modelo recebe a instrução de nunca
abrir, listar ou buscar esses caminhos; é uma instrução ao modelo, não uma caixa de
areia. Nenhum limite vale se você não definir um (`max_words`, `max_questions` e
`write_caps` são `null` por padrão), e `briefing.enabled: false` desliga o briefing no
vault.

O `questions` guarda a fila de perguntas abertas de uma manhã para outra: sem duplicatas
pelo texto normalizado, escaladas depois de feitas em três dias e arquivadas depois de 45
dias (os dois por padrão) pelo `questions sweep`, que imprime cada uma que arquiva. O que
você responde, e o que o briefing captura, vira um único pull request pelo `propose
--only`; sem nada a registrar, não há pull request. O briefing com horário exige o aplicativo
Claude para desktop: o `schedule install --job briefing` imprime a tarefa a criar nele, que a
skill `setup` registra para você; ela roda enquanto o aplicativo está aberto, e na próxima
abertura dele quando estava fechado. Uma sessão que começa com o prompt da tarefa nunca chega
ao curador; um briefing que você pede numa sessão sua é seu, e o curador o lê. O
[docs/briefing.md](docs/briefing.md) explica os blocos, os fatos e de onde cada um vem, a
fila, a tarefa no aplicativo e o que nunca muda.

O aplicativo para desktop não entrega o prompt da tarefa à sessão como ele é. Medido na
primeira execução real, a primeira mensagem da sessão é o prompt embrulhado num envelope:
uma tag de abertura `<scheduled-task ...>`, um parágrafo com as palavras do próprio
aplicativo, o prompt e uma tag de fechamento. O curador enxerga através dele, pelo nome da
tarefa ou pelo prompt que está dentro, e por isso a assinatura continua sendo a primeira
linha do prompt. Se um dia o aplicativo mudar o envelope para uma forma que o curador não
reconheça, a sessão é lida como uma sua: o custo é o de um briefing que você mesmo pede
(uma captura que a próxima rodada pode propor de novo, visível no diff, nada se perde), e
só quando o diretório de trabalho da tarefa é um projeto listado em
`sources.transcripts.include_projects`. A linha `plan` do log da rodada conta, em
`selfTrace`, as sessões que ela deixou de fora como do próprio kit; o
[docs/briefing.md](docs/briefing.md), em "Which sessions the curator skips", tem os
detalhes.

## O plugin do Claude Code

Carregue a partir de um clone com `claude --plugin-dir caminho/do/brain-kit`, ou instale
pelo marketplace. Dentro de um vault:

- o hook `SessionStart` registra quais arquivos já estavam sujos quando a sessão começou,
  e mantém esse registro depois de uma compactação;
- o hook `Stop` pede à sessão que cure só o que ela mesma mudou. Ele nunca bloqueia fora
  de um vault, numa cópia longe do caminho registrado do vault, enquanto outro processo
  segura o lock, nem duas vezes seguidas, e deixa de fora um arquivo cujos bytes ainda
  são exatamente o que um `propose` anterior enviou (uma proposta nunca mexe na árvore de
  trabalho, então os arquivos dela continuam mudados até o próximo `sync` devolvê-los ao
  conteúdo do branch padrão; um byte editado depois do envio torna o arquivo trabalho da
  sessão de novo);
- nove skills conduzem o motor no idioma do próprio vault: `setup`, `curate-session`,
  `capture`, `ask`, `lint`, `review-stale`, `approve`, `seed-rituals` e `briefing`;
- o subagente `vault-reader` lê notas só com Read, Grep e Glob.

A pasta `evals/` traz um caso de `claude plugin eval` por skill e idioma; veja
[docs/testing.md](docs/testing.md).

## Status

<!-- status-reviewed: 0.0.8 -->

| Fase | Conteúdo | Estado |
|---|---|---|
| 0 | Esqueleto, códigos de saída, packs de idioma, schemas de config, trava anti-vazamento, CI, docs | concluída, 0.0.1 no npm |
| 1 | Validador, lint, propose (loop de PR), hook Stop, init, doctor, skills | concluída |
| 2 | Curador agendado sobre transcripts locais, templates de agendamento | concluída |
| 3 | Fontes de agenda e notas de reunião (best effort por desenho) | concluída |
| 4 | Briefing matinal | concluída |
| 5 | Migração do vault original para o kit | em andamento. Feito: a 5a (o que um vault em migração precisa, desde a 0.0.2); o curador agendado do vault saiu dos scripts legados para o kit em 01/10/2026 (um timer de usuário do systemd às 09:30 com novas tentativas às 14:00 e às 20:00, o timer legado desativado) e as primeiras rodadas reais foram acompanhadas; o modelo lê um extrato em texto de cada transcript (0.0.5); o briefing matinal roda como tarefa do aplicativo para desktop e rodou pela primeira vez em 01/10/2026, e desde a 0.0.6 o curador reconhece a sessão dele pelo envelope que o aplicativo põe em volta do prompt da tarefa. Falta para a fase terminar: cinco rodadas do curador e três briefings sem falha inexplicada, a limpeza dos scripts legados depois de sete dias estáveis e o primeiro `verify` no vault |
| 6 | Publicação 0.1.0 no npm | em andamento. Feito: `docs/incident-response.md`, `examples/minimal-vault`, uma caminhada de um estranho numa máquina limpa (ela achou as lacunas entre o `init` e o primeiro pull request; a 0.0.8 as fechou, menos uma lista curta de pequenas), e uma Release no GitHub com o texto do CHANGELOG para cada tag. Falta: uma execução por um adotante externo (o critério da 0.1.0: de uma máquina limpa a um vault validado, o plugin instalado, o hook ativo e o primeiro pull request em menos de 30 minutos) e a saída da fase 5 |
| 7 | Outras forjas, outros harnesses, mais fontes, cada um só quando um segundo caso real precisar | planejada |

A tag mais recente é a `v0.0.8`. Toda versão a partir da 0.0.2 é só uma tag do git: o
pacote `second-brain-kit` no npm continua com apenas a 0.0.1, o esqueleto da fase 0.

O kit está em construção. A fase 1 está concluída: o validador, o linter, as travas de push,
o `init`, o `init --adopt`, o `update`, o `doctor`, o loop de pull request (`sync`,
`propose`, `verify`) e o plugin do Claude Code (hooks, skills, um subagente somente
leitura) já funcionam hoje, a partir de um clone deste repositório ou da instalação acima.
A fase 2 também está concluída: o curador agendado (`curate`, `watermark`, `schedule`) lê
as suas sessões recentes do Claude Code e abre um pull request a partir de uma rodada sem
ninguém por perto. A fase 3 também está concluída: a rodada lê ainda a sua agenda e as suas
notas de reunião pelos conectores do claude.ai, depois que você os liga. A fase 4 também
está concluída: o briefing matinal (`preflight`, `questions`, a skill `briefing` e a tarefa
dela no aplicativo para desktop). A fase 5a trouxe o que um vault que sai de scripts
próprios precisa: o `watermark import`, uma ponte para uma trava `flock` legada e rodadas
sem teto de custo, de turnos ou de tempo quando a configuração não pede nenhum. A fase 5
está em andamento: o vault de referência de onde este kit saiu já roda a configuração, o
CI, a trava de push e o hook Stop pelo kit, e, desde 01/10/2026, o curador agendado dele
também roda pelo kit (o timer legado está desativado) e o briefing matinal dele roda como
tarefa do aplicativo para desktop; o que ainda falta para a fase terminar está na tabela
acima. A publicação 0.1.0 no npm é a fase 6, que está em andamento (veja a linha dela).

A fase 1 é construída em cinco fatias:

| Fatia | Conteúdo | Estado |
|---|---|---|
| 1A | Leitor de vault, frontmatter, markdown, `validate` | concluída |
| 1B | `lint` e suas oito regras, o scanner de vazamento, as duas travas de push | concluída |
| 1C | `propose` (o loop de PR) e `sync` | concluída |
| 1D | `init`, `init --adopt`, `update`, `doctor` | concluída |
| 1E | Superfície do plugin: skills, hooks Stop e SessionStart, subagente somente leitura, evals | concluída |

## Segurança

Existem duas travas de push, com alcances diferentes. A trava deste repositório varre todo
objeto que um push carrega contra uma lista pessoal de padrões mantida fora do repositório.
O hook de template feito para um vault, em `templates/githooks/`, roda `validate` e `lint`
sobre a árvore de trabalho e depois a mesma varredura de objetos sobre o que o push carrega,
contra os padrões configurados do próprio vault, os da árvore de trabalho, os de cada ponta
enviada e os do branch padrão juntos. O `init` o instala em todo vault novo, o
`init --adopt` num vault existente a menos que já haja lá um hook da própria pessoa, e o
`brain-kit update --install-hook` depois. Uma recusa por correspondência termina dizendo o
que fazer: revogar a credencial, tirá-la do histórico e seguir o `SECURITY.md` do vault. O
[SECURITY.md](SECURITY.md) lista o que as travas não cobrem.

## Contribuindo

Leia primeiro o [CONTRIBUTING.md](CONTRIBUTING.md). Todo clone precisa rodar
`.githooks/install-gate` uma vez, senão aquele clone não tem trava anti-vazamento nenhuma.

## Por quê

Leia [docs/rationale.md](docs/rationale.md) para o raciocínio e
[docs/incidents.md](docs/incidents.md) para as falhas datadas que produziram cada guarda.

## Licença

MIT. README em inglês: [README.md](README.md).
