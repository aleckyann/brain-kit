# brain-kit

Um segundo cérebro que lembra por você, só anota o que leu e pede licença antes de mexer.

## Em 30 segundos

- Suas notas são arquivos de texto simples (Markdown) numa pasta do seu computador, o vault, com uma cópia privada no GitHub que guarda todo o histórico.
- O Claude, pelo Claude Code (o assistente da Anthropic que roda no terminal, a janela de comandos), lê essas notas quando você pergunta e propõe mantê-las em dia a partir do seu trabalho.
- Cada mudança chega como um pull request, um pedido de mudança que você lê e aprova no GitHub. Sem a sua aprovação, nada entra.

## Por que isso existe

Quem usa IA todo dia conhece o ritual: colar o mesmo contexto no começo de cada conversa,
explicar de novo quem é quem e o que ficou combinado, e torcer para ela não preencher as
lacunas com imaginação. Ela esquece o que você disse ontem e, quando ganha permissão para
escrever, escreve onde bem entende.

O brain-kit nasceu de um segundo cérebro de verdade, usado todo dia por um fundador para
guardar pessoas, decisões, promessas e o que saiu de cada reunião. O kit é esse jeito de
trabalhar empacotado para qualquer pessoa, e cada trava dele veio de uma falha real, com data:
o [docs/incidents.md](docs/incidents.md) conta qual (em inglês).

## O que você ganha

- **Memória que não some.** O que foi dito na reunião da semana passada está numa nota, e não na boa vontade da IA.
- **Atualização que chega sozinha.** Ligue o curador (a IA que mantém as notas em dia) e todo dia ele lê o que você fez na véspera e abre o pull request por você.
- **Nada muda sem você.** Toda mudança é um pull request que você aprova no GitHub, até pelo celular, na fila do pão.
- **Um briefing de manhã.** O que vence hoje, o que atrasou e o que espera a sua aprovação, num resumo só.
- **Seus dados são seus.** Arquivos de texto numa pasta sua e numa cópia privada no GitHub: abrem em qualquer editor, e o kit não tem servidor nem conta para te prender.
- **Grátis e aberto.** Licença MIT, e o trabalho de IA sai do seu próprio plano do Claude.

## Para quem é

- **Quem lidera gente.** Fundador, gestor, coordenador: as reuniões 1:1, as decisões com o porquê e a promessa de mandar o feedback para a Ana até sexta.
- **Quem atende muitos clientes.** Consultor, freelancer, agência: uma nota por cliente, o que ficou combinado em cada reunião e o que ainda está pendente.
- **Quem estuda.** Pesquisador, estudante, leitor compulsivo: uma nota por livro, com as suas reflexões ligadas umas às outras.
- **Quem vive dentro do Claude Code.** E cansou de colar contexto: abra o Claude Code na pasta do vault e pergunte; a resposta vem das notas, com o caminho de cada uma, ou um "não sei" honesto.
- **Quem decide e depois esquece por quê.** A decisão fica com a data e o motivo, e ninguém precisa rediscutir tudo daqui a seis meses.

Ainda não é para você se não quer criar uma conta no GitHub nem usar o terminal (a janela
onde se digitam comandos), porque o caminho passa pelos dois; se usa Windows e quer as rodadas
automáticas, que lá não existem (o kit só é testado em Linux e macOS); ou se não usa o Claude
Code.

## Como funciona

O ciclo tem três passos:

1. **Você trabalha.** Conversa com o Claude Code, vai a reuniões, mexe na agenda. Numa sessão dentro do vault, quando o Claude muda alguma coisa, o plugin do kit (um complemento do Claude Code) pede a ele, no fim da resposta, que confira e proponha a mudança.
2. **O curador lê e propõe.** O curador faz uma rodada (uma passada pelas novidades) no horário que você agendar, ou quando você pede: lê os dias que ainda não leu (o de hoje ele lê amanhã, quando acabar), escreve no log (o diário do vault) e nas notas, confere tudo e abre um pull request.
3. **Você aprova.** Lê o pull request no GitHub e faz o merge, o clique que aprova. É a única porta de entrada do vault.

```text
você trabalha       sessões do Claude Code, reuniões, agenda
      |
      v
o curador propõe    um pull request com o que mudou
      |
      v
você aprova         um merge no GitHub, até pelo celular
      |
      v
o vault fica em dia e o briefing da manhã conta onde ele está
```

O curador só enxerga o vault e o que a rodada lista: por padrão, as sessões do Claude Code
abertas dentro da pasta do vault (outros projetos entram se você listar), e a agenda e as
notas de reunião se você ligar os conectores, as pontes do claude.ai com o Google Agenda e o
Google Drive. Ele não navega na internet nem lê o resto do computador, e é instruído a nunca
inventar: o que não está numa fonte que ele leu, ele não sabe. Instrução não é garantia, e IA
erra; é por isso que nada entra sem o seu merge.

De manhã, o briefing conta onde o vault está: o que vence hoje, o que atrasou, os pull requests
esperando você e as perguntas que ele precisa que você responda. Ele roda no horário pelo
aplicativo Claude para desktop, ou quando você pede.

Os dados ficam na pasta do vault, no seu computador, e no seu repositório privado no GitHub. O
estado da máquina (o último dia lido e os registros das rodadas) fica fora do vault, em
`~/.local/state/brain-kit/`, e nunca vai para o GitHub. O kit não tem servidor: o que a IA lê
passa pela sua conta do Claude, como em qualquer sessão do Claude Code.

### Palavras que você vai ver

| Palavra | O que quer dizer |
|---|---|
| terminal | a janela onde você digita comandos |
| repositório | uma pasta cujo histórico o git guarda; o GitHub guarda uma cópia dela na internet |
| commit | um ponto salvo no histórico, com uma mensagem que diz o que mudou |
| push | o envio dos seus commits para a cópia no GitHub |
| pull request | um pedido para juntar mudanças ao vault, que você lê e aprova no GitHub |
| merge | aprovar um pull request: as mudanças dele entram no vault |
| vault | a pasta das suas notas (o seu segundo cérebro), que é um repositório |
| trava de push | a conferência que roda antes de cada push e barra senhas e chaves esquecidas |
| plugin, skill, hook | o plugin acrescenta ao Claude Code skills (instruções prontas que ele segue quando você pede, como a `capture`) e hooks (programas que rodam sozinhos quando algo acontece) |

## O que você precisa

- **Node.js 22 ou mais novo (o 24 LTS é o recomendado)**, o motor que roda o kit; LTS é a versão de suporte longo. Baixe em [nodejs.org](https://nodejs.org); `node --version` mostra qual você tem.
- **git**, que guarda o histórico das notas: [git-scm.com](https://git-scm.com/downloads).
- **Uma conta no GitHub**, onde fica a cópia privada e onde você aprova: [github.com/signup](https://github.com/signup).
- **O `gh`**, o GitHub no terminal, com o login feito (o passo 2 cuida disso): [cli.github.com](https://cli.github.com).
- **O Claude Code**, com um plano do Claude: [code.claude.com](https://code.claude.com/docs/en/overview) (em inglês).

Na primeira vez, conte com cerca de 35 minutos até o primeiro pull request: uns 10 de leitura,
21 nos passos abaixo e mais alguns para aprovar no GitHub. São estimativas, não uma promessa. O
curador agendado, a agenda, as notas de reunião e o briefing com horário são opcionais e ficam
para depois: o [guia completo](docs/guia.md#o-curador-agendado) apresenta cada um, com o que
ele exige.

## Passo a passo

Onze passos, do zero ao primeiro pull request aprovado. Cada um diz o que faz, o comando para
colar no terminal e o que deve aparecer na tela. Os comandos são exatamente os que foram
testados, e as mensagens citadas são as de um sistema em português.

1. **Instale o kit e o plugin.** Cole o trecho inteiro no terminal. Ele baixa o kit, descobre sozinho a versão mais recente, instala o comando `brain-kit` e o plugin do Claude Code:

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

   No fim, o plugin diz que foi instalado (em inglês, `Successfully installed`); para conferir o kit, `brain-kit --version` mostra a versão instalada. A pasta `brain-kit` que a primeira linha baixou (ela fica onde você colou o trecho) não é mais usada e pode ser apagada. Já a pasta `~/.local/share/brain-kit/`, que o trecho cria, **não pode ser apagada**: é dela que o Claude Code carrega o plugin. Apareceu `EACCES`? Veja [Se aparecer `EACCES`](#se-aparecer-eacces), logo depois dos passos.
2. <a id="passo-2"></a>**Entre no GitHub.** O kit abre os pull requests com o `gh`, que precisa do seu login. O `gh` faz algumas perguntas e abre o navegador para você confirmar um código:

   ```bash
   gh auth login
   ```

   No fim, ele diz `Logged in as` e o seu usuário.
3. <a id="passo-3"></a>**Confira a máquina.** Sem vault ainda, o `doctor` confere só a máquina: o Node, o git, o `gh` e o login dele, e o Claude Code.

   ```bash
   brain-kit doctor
   ```

   Está tudo certo quando a linha que começa com `doctor:` termina em `0 falha(s)`. A mensagem "nenhum vault brain-kit encontrado", que vem logo depois, é esperada: o vault vem no próximo passo. Uma linha `falha` diz o que rodar para corrigir. Num sistema em inglês, as palavras saem como `fail` e `warn`, e a linha termina em `0 fail`.
4. <a id="passo-4"></a>**Crie o vault**, numa pasta nova (ou vazia):

   ```bash
   brain-kit init ~/my-brain
   ```

   Ele faz sete perguntas, uma de cada vez: idioma, primeiro nome, apelido curto, título, repositório, se ele será privado e fuso horário. Na pergunta "Apelido curto" (o nome curto que assina as suas aprovações), aceite a sugestão: é só apertar Enter. No fim, ele diz que conferiu o vault novo sem nenhuma ocorrência, avisa que não fez commit e mostra os próximos passos. O repositório no GitHub ele não cria: isso é o passo 6.
5. <a id="passo-5"></a>**Faça o primeiro commit**, o primeiro ponto salvo no histórico:

   ```bash
   cd ~/my-brain
   git add -A
   git commit -m "Inicia o vault"
   ```

   Deu certo quando ele mostra "Inicia o vault" e a lista dos arquivos salvos. O git guarda quem fez cada commit, então precisa saber quem você é. Se ele recusar, dizendo `Author identity unknown` ou `Please tell me who you are`, rode estes dois comandos, com o seu nome e o seu e-mail no lugar dos de exemplo (o `example.com` é só um exemplo), e repita o `git commit`:

   ```bash
   git config --global user.name "Seu Nome"
   git config --global user.email "voce@example.com"
   ```

6. <a id="passo-6"></a>**Mande o vault para o GitHub**, num repositório privado, com um comando só:

   ```bash
   gh repo create my-brain --private --source . --push
   ```

   Privado porque o vault guarda notas sobre pessoas. O `--push` é o que põe as notas lá: sem ele, a cópia no GitHub fica vazia e o `propose` (o comando que abre os pull requests) não funciona. Antes de enviar, a trava de push confere o vault e procura senhas e chaves esquecidas, num relatório comprido, com umas linhas em inglês no fim. Deu certo quando a última linha dela diz `nothing matched` (nada encontrado) e nenhuma diz `refusing to push` (a recusa); a linha que fala em `git fetch origin` aparece no primeiro envio e não pede nada.
7. <a id="passo-7"></a>**Confira de novo, agora com o vault:**

   ```bash
   brain-kit doctor
   ```

   A saída mostra só os avisos e as falhas, com a contagem das linhas `ok` (`brain-kit doctor --verbose` mostra todas). Saudável é não ter nenhuma linha `falha`: a última linha termina em `0 falha(s)`. Por enquanto, as linhas `aviso` sobre o curador agendado (`watermark`, `last-run`, `schedule`, `notify` e `briefing`) são normais: você ainda não ligou nada disso.
8. **Abra o Claude Code dentro do vault** (`cd ~/my-brain` antes, se você abriu outro terminal):

   ```bash
   claude
   ```

   Se ele perguntar se você confia nesta pasta, responda que sim. Com o plugin instalado, as skills e os hooks do kit já valem aqui.
9. **Conte a primeira novidade.** Peça ao Claude algo como "Registre no log que comecei este vault hoje": a skill `capture` escreve a entrada com a data em `memoria/log.md`. Se preferir escrever você mesmo, acrescente nesse arquivo um título `## AAAA-MM-DD` com a data de hoje e, embaixo, uma linha que começa com `**Captura**` (num vault em inglês, o arquivo é `memory/log.md` e o marcador, `**Capture**`).
10. **Abra o primeiro pull request.** Quando o Claude termina a resposta, o hook `Stop` vê o arquivo mudado e pede a ele que confira o vault e proponha a mudança; o Claude Code costuma pedir licença para rodar os comandos, e pode dar. Para fazer você mesmo:

    ```bash
    brain-kit propose "Primeira captura" --only memoria/log.md
    ```

    Deu certo quando ele diz `Pull request aberto` e mostra o endereço do pull request no GitHub. Quer ver o plano antes? Acrescente `--dry`. E não faça commit desse arquivo: deixe-o como está até o merge (passo 11). O `propose` monta o commit dele à parte, e um commit seu do mesmo arquivo faz o `sync` recusar depois, dizendo que os branches (as linhas de trabalho) divergiram.
11. <a id="passo-11"></a>**Aprove no GitHub.** Abra o pull request e faça o merge: é a sua aprovação, e a única forma de o vault mudar. Depois, no terminal, o `brain-kit sync` traz o arquivo aprovado para a sua pasta e deixa tudo em dia com o GitHub, e o `brain-kit verify --pr <número>` carimba `verified` (verificada) nas notas que o pull request mudou. Neste primeiro, que só mexeu no log (o log não é uma nota), ele diz "nada a carimbar, e nada foi escrito": é isso mesmo.

Pronto. O próximo passo, quando você quiser, é ligar o
[curador agendado](docs/guia.md#o-curador-agendado), que alimenta o vault sem você pedir, e o
[briefing matinal](docs/guia.md#o-briefing-matinal), que conta toda manhã onde ele está. Vai
usar o vault em outra máquina? O guia tem [o caminho](docs/guia.md#o-mesmo-vault-em-uma-segunda-máquina).

### Se aparecer `EACCES`

`EACCES` quer dizer "permissão negada": o npm (o instalador que vem com o Node) tentou instalar
numa pasta do sistema, onde você não pode gravar. Costuma acontecer quando o Node veio do
instalador do sistema; quem instalou o Node com o nvm não vê este erro e pode pular este bloco.
Evite o `sudo` (rodar como administrador), que costuma deixar arquivos do administrador na sua
pasta e causar mais erros de permissão depois: mande o npm instalar numa pasta sua. Rode uma
vez:

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

### Para atualizar depois

Para passar a uma versão mais nova, apague a pasta `brain-kit` que a primeira linha baixou, se
ela ainda existir (senão o trecho reaproveita essa cópia velha e instala a versão velha), cole o
trecho do passo 1 de novo e registre a versão nova no Claude Code:

```bash
claude plugin update brain-kit@brain-kit
```

Abra o Claude Code de novo em seguida. As pastas das versões antigas em
`~/.local/share/brain-kit/` não são mais usadas e podem ser apagadas; a mais nova não.

## Se travar

- `EACCES` ao instalar (o npm não pode gravar onde queria): use os comandos de [Se aparecer `EACCES`](#se-aparecer-eacces).
- O `gh` pede login: rode `gh auth login` ([passo 2](#passo-2)) e tente de novo.
- O `propose` pede o primeiro commit ([passo 5](#passo-5)) ou o `origin`, o endereço do GitHub ([passo 6](#passo-6)); se ele diz "Envie o branch padrão primeiro", o repositório já existe: rode `git push -u origin HEAD` (repetir o `gh repo create` falha).
- `command not found` (ou `comando não encontrado`) para o `brain-kit` depois de instalar: o npm pode ter recusado no meio da saída, que termina em "Successfully installed" mesmo assim; siga o bloco [Se aparecer `EACCES`](#se-aparecer-eacces) inteiro, do começo.
- O `doctor` diz `falha` no `gh-auth`: o login do `gh` venceu ou nunca foi feito; rode o comando que a linha mostra, `gh auth login --hostname github.com`.
- Uma senha ou chave apareceu no vault: pare e siga o [docs/incident-response.md](docs/incident-response.md) (em inglês).

## Privacidade

Por padrão, o curador guarda tudo o que as suas sessões, a agenda e as notas de reunião ensinam
ao vault, inclusive informação pessoal e sensível (saúde, família, finanças), a sua e a de
outras pessoas. Por isso o repositório do vault precisa continuar privado. Para guardar menos,
ajuste `privacy.sensitive` no `brain-kit.config.json`; o guia explica cada nível em
[Privacidade: o que o curador guarda](docs/guia.md#privacidade-o-que-o-curador-guarda).

Para leis de privacidade como a LGPD e o GDPR, o que o vault guarda sobre outras pessoas é dado
pessoal, e os dados sobre a saúde, a vida sexual, a convicção religiosa ou a opinião política
delas, entre outras categorias que essas leis listam, são dados pessoais sensíveis; como dono do
vault, é você quem responde por guardá-los, então registre dos outros o que você tem motivo para
guardar.

## Quanto custa

O kit é grátis e de código aberto (licença MIT). Quem trabalha é o Claude, pelo seu próprio
plano. Para ter uma ideia: no vault de referência, de onde o kit saiu, as rodadas do curador de
01 e 02/10/2026 ficaram entre US$ 0,78 e US$ 4,45 cada, pelo `costUsd` que o `last-run.json`
guarda. Esse é o valor que o próprio Claude Code informa, calculado como se fosse uso avulso pela
API (o acesso pago por uso): numa assinatura do Claude, ele conta para os limites do plano e não
vira cobrança em dólar. Um vault novo já vem com um teto de US$ 5 por rodada, nessa mesma conta
(`curate.budget_usd`), que você pode mudar.

## Em que pé está

<!-- status-reviewed: 0.0.10 -->

O kit está em construção, mas o vault de referência, usado todo dia, já roda pelo kit, e desde
01/10/2026 também o curador agendado e o briefing. Cada versão é uma tag do git (um marcador de
versão). A tag mais recente é a `v0.0.10`. O pacote `second-brain-kit` no npm continua com
apenas a 0.0.1, um esqueleto antigo: instale pelo [passo 1](#passo-a-passo). Entre o que falta
para a 0.1.0 está alguém de fora do projeto fazer este passo a passo de ponta a ponta (quem sabe
você); cada fase está no [guia completo](docs/guia.md#status).

## Quer mais?

- [Guia completo](docs/guia.md): tudo em detalhe e em português, dos comandos à segunda máquina, do curador agendado à tabela de fases.
- [docs/scheduling.md](docs/scheduling.md): as rodadas agendadas, passo a passo (em inglês).
- [docs/connectors.md](docs/connectors.md): a agenda e as notas de reunião pelos conectores do claude.ai (em inglês).
- [docs/security.md](docs/security.md) e [SECURITY.md](SECURITY.md): o que isola a IA e o que as travas não cobrem (em inglês).
- [docs/incident-response.md](docs/incident-response.md): o que fazer se uma senha ou um dado pessoal vazar (em inglês).
- [English version of the complete guide](docs/guide.md).
- [CHANGELOG](CHANGELOG.md), [CONTRIBUTING](CONTRIBUTING.md) e a [licença MIT](LICENSE).
