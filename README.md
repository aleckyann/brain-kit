# brain-kit

Um segundo cérebro que lembra por você, só anota o que leu nas suas conversas e pede licença antes de mexer.

## Em 30 segundos

- Suas notas são arquivos de texto comuns numa pasta do seu computador, que o kit chama de vault, com uma cópia privada no GitHub, um site que guarda cada versão dos arquivos.
- Você conversa com o Claude pelo Claude Code, o Claude que roda no terminal (a janela de comandos), com a mesma conta do site e do aplicativo, num plano pago. Ele lê as notas antes de responder.
- Um curador, a IA que mantém o vault em dia, lê só as suas conversas com o Claude Code feitas dentro do vault e, se você conectar, a Google Agenda e as notas de reunião do Google Drive. E-mail, WhatsApp, ChatGPT, Outlook, Teams e o resto do computador ficam de fora.
- Cada mudança chega como um pull request, um pedido de mudança que você lê e aprova no GitHub. Sem a sua aprovação, nada entra.

O passo a passo deste README monta o vault com a aprovação por pull request. O curador diário e o
briefing da manhã você liga depois, pelo [guia](docs/guia.md#o-curador-agendado). As palavras
novas estão em [Palavras que você vai ver](#palavras-que-você-vai-ver).

## Por que isso existe

Quem usa IA todo dia conhece o ritual: colar o mesmo contexto no começo de cada conversa,
explicar de novo quem é quem e o que ficou combinado, e torcer para ela não preencher as
lacunas com imaginação. Ela esquece o que você disse ontem e, quando você deixa ela mexer nos
seus arquivos, mexe onde quer.

O brain-kit nasceu de um segundo cérebro de verdade, usado todo dia por um fundador para guardar
pessoas, decisões, promessas e o que saiu de cada reunião. Cada trava do kit veio de uma falha real,
com data: em setembro de 2026, o curador passou quatro dias parado enquanto o agendador dizia que
estava tudo certo; hoje uma rodada adiada sai com falha e diz por quê ([cada uma](docs/incidents.md), em inglês).

## O que você ganha

- **Memória que não some.** O que você contou ao Claude sobre a reunião da semana passada está numa nota, e não na boa vontade da IA.
- **Atualização que chega sozinha.** Ligado o curador (fica para depois do passo a passo), todo dia ele lê as suas conversas da véspera com o Claude Code e, se você conectar, a agenda e as notas de reunião, e abre o pull request por você.
- **Nada muda sem você.** Toda mudança é um pull request que você aprova no GitHub, até pelo celular, na fila do pão.
- **Um briefing de manhã.** O que vence hoje, o que atrasou e o que espera a sua aprovação, num resumo só (também se liga depois).
- **Seus dados são seus.** Arquivos de texto numa pasta sua e numa cópia privada no GitHub, que abrem em qualquer editor. O kit em si não tem servidor nem cadastro: se você sair, as notas ficam.
- **O kit é grátis.** O código é aberto, e o trabalho de IA sai de um plano pago do Claude (veja [Quanto custa](#quanto-custa)).

## Para quem é

- **Quem lidera gente.** Fundador, gestor, coordenador: as reuniões 1:1, as decisões com o porquê e a promessa de mandar o feedback para a Ana até sexta.
- **Quem atende muitos clientes.** Consultor, freelancer, agência: uma nota por cliente, o que ficou combinado em cada reunião e o que ainda está pendente.
- **Quem estuda.** Pesquisador, estudante, leitor compulsivo: uma nota por livro, com as suas reflexões ligadas umas às outras.
- **Quem vive dentro do Claude Code.** E cansou de colar contexto: abra o Claude Code na pasta do vault e pergunte; a resposta vem das notas, com o caminho de cada uma, ou um "não sei" honesto.
- **Quem decide e depois esquece por quê.** A decisão fica com a data e o motivo, e ninguém precisa rediscutir tudo daqui a seis meses.

Ainda não é para você se:

- não quer criar uma conta no GitHub;
- não quer usar o terminal;
- não quer assinar um plano pago do Claude e passar a conversar com ele pelo Claude Code;
- usa Windows: este passo a passo é para o terminal do Linux e do macOS, os únicos testados, e o curador agendado não roda no Windows.

## Como funciona

1. **Você trabalha.** Você conversa com o Claude Code dentro da pasta do vault. Quando ele altera uma nota, o kit lembra o Claude de propor essa mudança para você aprovar.
2. **O curador lê e propõe.** No horário que você escolher (ou quando você pedir), o curador faz uma rodada, uma passada pelas novidades. Ele lê os dias que ainda não leu, sempre até ontem, porque hoje ainda não terminou; anota as novidades no log, o diário do vault; atualiza as notas; confere tudo e abre um pull request.
3. **Você aprova.** Lê o pull request no GitHub e faz o merge, o clique que aprova. É a única porta de entrada do vault.

O curador não navega na internet nem lê o resto do computador, e é instruído a nunca inventar:
o que não está numa fonte que ele leu, ele não sabe. Instrução não é garantia, e IA erra; é por
isso que nada entra sem o seu merge.

De manhã, o briefing conta como o vault está: o que vence hoje, o que atrasou, os pull requests
esperando você e as perguntas que ele precisa que você responda. Ele roda no horário pelo
aplicativo Claude para desktop, ou quando você pede.

Os dados ficam na pasta do vault e no repositório privado (fora do vault, o kit só guarda até onde
já leu e os registros das rodadas). O kit não tem servidor: o que a IA lê passa pela sua conta do
Claude, como em qualquer conversa.

### Palavras que você vai ver

| Palavra | O que quer dizer |
|---|---|
| terminal | a janela onde você digita comandos |
| git e GitHub | o git anota cada versão dos arquivos; o GitHub guarda uma cópia na internet |
| repositório | uma pasta com esse histórico; o vault é um |
| commit e push | um commit é um ponto salvo no histórico; o push envia os commits ao GitHub |
| pull request e merge | o pedido de mudança que você lê no GitHub, e o clique que o aprova |
| branch | uma linha de trabalho do repositório; a principal se chama `main` ou `master` |
| vault | a pasta das suas notas, o seu segundo cérebro |
| log | o diário do vault: cada novidade numa linha com data; as notas são escritas a partir dele |
| curador e rodada | a IA que mantém o vault em dia, e cada passada dela pelas novidades |
| trava de push | a conferência que roda antes de cada push e barra senhas e códigos de acesso secretos |
| plugin e marketplace | o plugin é um complemento do Claude Code; o marketplace, a lista de onde ele o instala |
| skill | uma instrução pronta que o Claude segue quando você pede, como a `capture`, que registra uma novidade |
| hook | um programa que roda sozinho quando algo acontece, como no fim de cada resposta do Claude |

## Como fica na prática

Um exemplo inventado. Na quinta, a Ana conta ao Claude Code, dentro do vault, que o Ben Okafor (um
cliente) pediu a proposta revisada até sexta. O Claude anota uma linha no log, `memoria/log.md`:

```markdown
**Captura** Na reunião de 01/10/2026, o Ben Okafor pediu a proposta revisada até sexta.
```

e abre o pull request "curadoria: pedido do Ben Okafor", que põe o prazo nas pendências e cria a nota dele:

```markdown
---
type: person
title: Ben Okafor
description: Cliente; decide o orçamento do site novo.
generated: { by: brain-kit-curator/<modelo>, at: 2026-10-01T16:12:00-03:00 }
sources:
  - resource: /memoria/log.md
---
- 01/10/2026: pediu a proposta revisada até sexta; prefere e-mail (ben@example.com).
```

Depois do merge, o briefing de sexta de manhã traz, entre outras coisas:

```text
Atrasadas e para hoje
- Proposta revisada para o Ben Okafor: vence hoje.
Perguntas
- A reunião de quinta com o Ben Okafor foi remarcada?
```

## Quanto custa

O kit é grátis e de código aberto (licença MIT: use, copie e mude à vontade). O que custa é o
Claude: o Claude Code pede um plano pago. Em 02/10/2026, a [página oficial de preços](https://claude.com/pricing)
dizia: o plano grátis não inclui o Claude Code; o Pro custa US$ 20 por mês (ou US$ 17 por mês no
plano anual); o Max, a partir de US$ 100 por mês ([detalhes](docs/preparar-o-computador.md#as-duas-contas)).

Numa assinatura, não há cobrança por rodada: cada rodada do curador usa uma parte dos limites de
uso do plano, os mesmos do resto do Claude (o projeto ainda não mediu que fração). Se o limite
acabar, a rodada falha e o dia fica para a próxima: nada se perde. Uma rodada sem nada para ler
termina sem chamar a IA e não gasta nada.

Só quem usa o Claude Code com uma chave de API (a conta de desenvolvedor, paga por uso) paga cada
rodada em dólar. No vault de referência, as rodadas que tiveram o que ler em 01 e 02/10/2026
custaram entre US$ 0,78 e US$ 4,45 cada, pelos registros de rodada do kit; um vault novo já vem
com um teto de US$ 5 por rodada, calculado do mesmo jeito (`curate.budget_usd`).

## Privacidade

Por padrão, o curador guarda tudo o que as suas conversas, a agenda e as notas de reunião ensinam
ao vault, inclusive informação pessoal e sensível (saúde, família, finanças), a sua e a de outras
pessoas. Por isso o repositório precisa continuar privado: só você e quem você convidar o veem.

Para guardar menos, dê um nível a cada público: você (`owner`), quem já tem nota no vault
(`people`) e todas as outras pessoas (`outsiders`). Os níveis são `save` (registra
normalmente), `summary` (registra que o assunto apareceu e o que foi decidido, sem os detalhes
íntimos) e `skip` (deixa de fora). Fica assim no `brain-kit.config.json`:

```json
"privacy": {
  "sensitive": { "owner": "save", "people": "summary", "outsiders": "skip" }
}
```

Não precisa editar o arquivo você mesmo: dentro do vault, peça ao Claude Code algo como "guarde
só um resumo do que for sensível sobre as outras pessoas". Ele muda o arquivo, e a mudança vira
um pull request como qualquer outra. É uma instrução ao curador, não uma garantia: você confere
no pull request o que ele escreveu ([cada nível no guia](docs/guia.md#privacidade-o-que-o-curador-guarda)).

Pela LGPD, o que você anota sobre outras pessoas é dado pessoal. Saúde, religião, vida sexual e
opinião política, entre outros, são dados sensíveis. Quem responde por eles é você, o dono do
vault: anote dos outros só o que tem motivo para guardar. Já o uso das suas conversas para treinar
modelos da Anthropic depende de uma escolha sua ([a política](https://code.claude.com/docs/en/data-usage)).

## Em que pé está

<!-- status-reviewed: 0.0.10 -->

O kit está em construção, mas o vault de referência, usado todo dia, já roda pelo kit, e desde
01/10/2026 também o curador agendado e o briefing. Cada versão é uma tag do git (um marcador de
versão). A tag mais recente é a `v0.0.10`. Não instale pelo npm, onde só existe a 0.0.1, um esqueleto
antigo. Os comandos do passo a passo foram testados pelo projeto, mas ninguém de fora fez o caminho
todo ainda (quem sabe você); cada fase está no [guia completo](docs/guia.md#status).

## O que você precisa

Nunca instalou nada disso? [Comece por aqui](docs/preparar-o-computador.md): o passo zero, para
Mac e para Linux, mostra como abrir o terminal e instalar cada item, com o que aparece na tela.

- **Node.js 22 ou mais novo (o 24 LTS é o recomendado)**, o motor que roda o kit; LTS é a versão de suporte longo: [nodejs.org](https://nodejs.org).
- **git**, que guarda o histórico das notas: [git-scm.com](https://git-scm.com/downloads).
- **Uma conta no GitHub**, grátis, com repositórios privados à vontade: [github.com/signup](https://github.com/signup).
- **O `gh`**, o GitHub no terminal: [cli.github.com](https://cli.github.com).
- **O Claude Code**, com um plano pago do Claude: [code.claude.com](https://code.claude.com/docs/en/overview) (em inglês).

Com tudo isso já instalado, conte com cerca de 35 minutos até o primeiro pull request: uns 10 de
leitura, 21 nos passos abaixo e mais alguns para aprovar no GitHub. São estimativas, não uma
promessa, e não incluem o passo zero.

## Passo a passo

Os onze primeiros passos montam o vault e o primeiro pull request aprovado; o décimo segundo é a
prova. Cada um diz o que faz, o comando para colar no terminal e o que deve aparecer. Algumas
mensagens saem em inglês mesmo num computador em português: cada passo diz qual procurar.

1. **Instale o kit e o plugin.** Parece feitiço de filme de hacker, mas são só oito linhas que baixam o kit, descobrem a versão mais recente e instalam o comando `brain-kit` e o plugin do Claude Code. Cole as oito de uma vez e espere o terminal parar de falar:

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

   Passa muito texto, parte em inglês; é normal. Deu certo se `brain-kit --version` mostrar um número de versão (não confie só no `Successfully installed` do plugin, que aparece mesmo quando o npm falha). Se aparecer `command not found`, veja [Se aparecer `EACCES`](#se-aparecer-eacces). A pasta `brain-kit` que a primeira linha baixou (num terminal recém-aberto, ela fica na sua pasta de usuário) não é mais usada e pode ir para o lixo. Já a pasta `~/.local/share/brain-kit/`, que o trecho cria, **não pode ser apagada**: é dela que o Claude Code carrega o plugin.
2. <a id="passo-2"></a>**Entre no GitHub.** O kit abre os pull requests com o `gh`, que precisa do seu login:

   ```bash
   gh auth login
   ```

   Ele faz algumas perguntas em inglês, e as respostas sugeridas servem (GitHub.com e o login pelo navegador): aperte Enter em cada uma. Depois ele mostra um código e abre o navegador, onde você cola o código e autoriza. No fim, o terminal diz `Logged in as` e o seu usuário.
3. <a id="passo-3"></a>**Confira a máquina.** Sem vault ainda, o `doctor` confere só a máquina: o Node, o git, o `gh` e o login dele, e o Claude Code.

   ```bash
   brain-kit doctor
   ```

   Está tudo certo quando a linha que começa com `doctor:` termina em `0 falha(s)`. A mensagem "nenhum vault brain-kit encontrado", que vem logo depois, é esperada: o vault vem no próximo passo. Uma linha `falha` diz o que rodar para corrigir.
4. <a id="passo-4"></a>**Crie o vault**, numa pasta nova (ou vazia). `~/my-brain` é a pasta `my-brain` dentro da sua pasta de usuário; se trocar o nome, troque também nos passos seguintes.

   ```bash
   brain-kit init ~/my-brain
   ```

   Ele faz sete perguntas, uma de cada vez, cada uma com uma sugestão entre colchetes. Em "Primeiro nome", digite o seu. Em todas as outras, aperte Enter: "Idioma", "Apelido curto" (o nome curto que assina as suas aprovações), "Título do vault", "Repositório no GitHub" (fica "ainda não": o passo 6 cria o `my-brain`), "O repositório precisa ser privado" (sim) e "Fuso horário" (o do seu computador). No fim, ele diz que conferiu o vault sem achar problema ("nenhuma ocorrência") e que ainda não salvou nada no histórico: é normal, isso é o passo 5.
5. <a id="passo-5"></a>**Faça o primeiro commit**, o primeiro ponto salvo no histórico. Se é a primeira vez que você usa o git neste computador, diga antes a ele quem você é, com o seu nome e o seu e-mail no lugar dos de exemplo (o e-mail da conta do GitHub serve):

   ```bash
   git config --global user.name "Seu Nome"
   git config --global user.email "voce@example.com"
   ```

   Depois, o commit:

   ```bash
   cd ~/my-brain
   git add -A
   git commit -m "Inicia o vault"
   ```

   Deu certo quando ele mostra "Inicia o vault" e a lista dos arquivos salvos. Se ele disser `Author identity unknown` ou `Please tell me who you are`, faltou o primeiro bloco: rode-o e repita o `git commit`.
6. <a id="passo-6"></a>**Mande o vault para o GitHub**, num repositório privado (o vault guarda notas sobre pessoas), com um comando só:

   ```bash
   gh repo create my-brain --private --source . --push
   ```

   O relatório da trava de push é comprido e meio em inglês, como bula de remédio: você só precisa achar duas coisas. Deu certo se aparecer `nothing matched` (a trava não achou senha nem código secreto) e, no fim, `Pushed commits to` (o envio terminou). A linha sobre `git fetch origin` é normal no primeiro envio: ignore. Se aparecer `refusing to push`, a trava achou um problema e não enviou nada; a mensagem logo acima diz qual, e [Se travar](#se-travar) ajuda.
7. <a id="passo-7"></a>**Confira de novo, agora com o vault:**

   ```bash
   brain-kit doctor
   ```

   Como no passo 3, saudável é não ter nenhuma linha `falha`: a linha que começa com `doctor:` termina em `0 falha(s)`. Por enquanto, as linhas `aviso` sobre o curador agendado (`watermark`, `last-run`, `schedule`, `notify` e `briefing`) são normais: você ainda não ligou nada disso.
8. **Abra o Claude Code dentro do vault** (`cd ~/my-brain` antes, se você abriu outro terminal):

   ```bash
   claude
   ```

   Se você ainda não entrou na sua conta do Claude, ele abre o navegador para isso. Se perguntar se você confia nesta pasta, responda que sim. Está pronto quando aparece a caixa para você escrever.
9. **Conte a primeira novidade.** Peça ao Claude algo como "Registre no log que comecei este vault hoje": a skill `capture` escreve a entrada com a data no log do vault, `memoria/log.md`.
10. **Abra o primeiro pull request.** Quando o Claude termina a resposta, o kit lembra a ele de conferir o vault e propor a mudança (é o hook `Stop`). Ele pede licença para rodar alguns comandos do `brain-kit`, como o `propose`: pode aprovar, com Enter no **Yes**. Deu certo quando aparece `Pull request aberto` e o endereço do pull request no GitHub. Se o Claude não abrir o pull request, rode você mesmo:

    ```bash
    brain-kit propose "Primeira captura" --only memoria/log.md
    ```

    > **Regra de ouro:** daqui para frente, quem salva no histórico é o `propose`, quando você aprova. Não faça commit dos arquivos do vault você mesmo: é pagar o boleto duas vezes e dar confusão depois (o `sync` recusa, dizendo que os branches divergiram).
11. <a id="passo-11"></a>**Aprove no GitHub.** Abra o endereço que o `propose` mostrou e clique em **Merge pull request** e depois em **Confirm merge** (o GitHub é em inglês). É a sua aprovação, e a única forma de o vault mudar. Depois, saia do Claude Code (digite `exit`) e rode no terminal, trocando o `1` pelo número do seu pull request, o que vem depois de `/pull/` no endereço (no primeiro, é 1 mesmo):

    ```bash
    brain-kit sync
    brain-kit verify --pr 1
    ```

    O `sync` traz o arquivo aprovado para a sua pasta e deixa tudo em dia com o GitHub. O `verify` carimba `verified` (verificada) nas notas que você aprovou; neste primeiro, que só mexeu no log (o log não é uma nota), ele diz "nada a carimbar, e nada foi escrito": é isso mesmo.
12. **A prova.** Abra o Claude Code de novo (`claude`) e pergunte "o que eu registrei hoje no vault?". O kit pede a ele que responda a partir das notas e diga o caminho de onde tirou (é a skill `ask`): aqui, o `memoria/log.md`. Quando o vault não tem a resposta, ele deve dizer que não sabe em vez de inventar; o caminho citado é o que você confere.

Pronto. Quando quiser, ligue o [curador agendado](docs/guia.md#o-curador-agendado), que alimenta o
vault sem você pedir, e o [briefing matinal](docs/guia.md#o-briefing-matinal), que conta toda manhã
como ele está. Outra máquina? O guia tem [o caminho](docs/guia.md#o-mesmo-vault-em-uma-segunda-máquina).

## Se travar

- `EACCES` ao instalar (o npm não pode gravar onde queria): use os comandos de [Se aparecer `EACCES`](#se-aparecer-eacces).
- O `gh` pede login: rode `gh auth login` ([passo 2](#passo-2)) e tente de novo.
- O `propose` pede o primeiro commit ([passo 5](#passo-5)) ou o `origin`, o endereço do GitHub ([passo 6](#passo-6)); se ele diz "Envie o branch padrão primeiro", o repositório já existe: não repita o passo 6, rode `git push -u origin HEAD`.
- `command not found` (ou `comando não encontrado`) para o `brain-kit` depois de instalar: o npm pode ter recusado no meio da saída, que termina em "Successfully installed" mesmo assim; siga o bloco [Se aparecer `EACCES`](#se-aparecer-eacces) inteiro, do começo.
- O `doctor` diz `falha` no `gh-auth`: o login do `gh` venceu ou nunca foi feito; rode o comando que a linha mostra, `gh auth login --hostname github.com`.
- Uma senha ou chave apareceu no vault: pare, troque essa senha ou chave onde ela vale, antes de qualquer outra coisa, e siga o [docs/incident-response.md](docs/incident-response.md) (em inglês).

### Se aparecer `EACCES`

`EACCES` quer dizer "permissão negada": o npm (o instalador que vem com o Node) tentou instalar
numa pasta do sistema, onde você não pode gravar. O [passo zero](docs/preparar-o-computador.md) já
evita isso, e quem instalou o Node com o nvm não vê este erro. Evite o `sudo` (rodar como
administrador): é chamar o síndico para abrir a porta da sua própria casa, resolve hoje e complica
amanhã. Mande o npm instalar numa pasta sua. Rode uma vez:

```bash
npm config set prefix ~/.local
```

Agora ponha essa pasta (`~/.local/bin`) no PATH, a lista de pastas onde o terminal procura os
comandos que você digita. Use a linha do seu terminal (o Linux costuma usar o bash, a primeira;
o macOS, o zsh, a segunda; na dúvida, rode as duas):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Feche o terminal e abra outro (é assim que o PATH novo passa a valer) e cole o trecho de instalação
de novo: a primeira linha vai reclamar que a pasta já existe (`fatal: destination path 'brain-kit'
already exists`), e as do plugin, que ele já está instalado; está tudo certo. Confira:

```bash
brain-kit --version
```

## Para atualizar depois

As versões novas aparecem nas Releases do repositório e no [CHANGELOG](CHANGELOG.md). Para passar
a uma, apague a pasta `brain-kit` que a primeira linha baixou, se ela ainda existir (senão o
trecho reaproveita essa cópia velha e instala a versão velha), cole o trecho do passo 1 de novo,
registre a versão nova no Claude Code com `claude plugin update brain-kit@brain-kit` e abra o
Claude Code de novo. As pastas das versões antigas em `~/.local/share/brain-kit/` não são mais
usadas e podem ser apagadas; a mais nova não.

## Quer mais?

- [Guia completo](docs/guia.md): tudo em detalhe e em português, dos comandos à segunda máquina, do curador agendado à tabela de fases.
- [Preparar o computador](docs/preparar-o-computador.md): o passo zero, no Mac e no Linux.
- [docs/scheduling.md](docs/scheduling.md) e [docs/connectors.md](docs/connectors.md): as rodadas agendadas, e a agenda e as notas de reunião pelos conectores do claude.ai (em inglês).
- [docs/security.md](docs/security.md) e [SECURITY.md](SECURITY.md): o que isola a IA e o que as travas não cobrem (em inglês).
- [docs/incident-response.md](docs/incident-response.md): o que fazer se uma senha ou um dado pessoal vazar (em inglês).
- [English version of the complete guide](docs/guide.md).
- [CHANGELOG](CHANGELOG.md), [CONTRIBUTING](CONTRIBUTING.md) e a [licença MIT](LICENSE).
