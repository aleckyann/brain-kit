# brain-kit

Um segundo cérebro que lembra o que você contou ao Claude e pede licença antes de mexer.

## Em 30 segundos

- Suas notas são arquivos de texto comuns numa pasta do seu computador, que o kit chama de vault, com uma cópia privada no GitHub, um site que guarda cada versão dos arquivos.
- Você conversa com o Claude pelo Claude Code, o Claude que roda no terminal (a janela de comandos), num plano pago: o mais barato que serve é o Pro, de US$ 20 por mês ([Quanto custa](#quanto-custa)). Ele lê as notas antes de responder.
- Um curador, a IA que mantém o vault em dia, lê só as suas conversas com o Claude Code feitas dentro do vault e, se você conectar, a Google Agenda e as notas de reunião do Google Drive. E-mail, WhatsApp, ChatGPT, Outlook, Teams e o resto do computador ficam de fora.
- Cada mudança chega como um pull request, um pedido de mudança que você lê e aprova no GitHub. Sem a sua aprovação, nada entra.

**No fim do passo a passo**, você tem um vault seu, em que toda mudança passa pela sua aprovação,
e o Claude respondendo a partir dele. **Depois, se quiser**: o [curador agendado](docs/guia.md#o-curador-agendado),
que lê sozinho as conversas da véspera, se liga com um comando; o [briefing da manhã](docs/guia.md#o-briefing-matinal)
pede dois passos, instalar o aplicativo Claude para desktop e, nele, pedir que o briefing seja registrado.
As palavras novas estão em [Palavras que você vai ver](#palavras-que-você-vai-ver).

## Por que isso existe

Quem usa IA todo dia conhece o ritual: colar o mesmo contexto no começo de cada conversa, explicar de
novo quem é quem e o que ficou combinado, e torcer para ela não preencher as lacunas com imaginação.
Ela esquece o que você disse ontem, e o que ela lembra fica guardado dentro do aplicativo dela.

O brain-kit nasceu de um segundo cérebro de verdade, usado todo dia por um fundador para guardar
pessoas, decisões, promessas e o que saiu de cada reunião. Cada proteção do kit nasceu de um
problema de verdade, com data ([um exemplo, no guia](docs/guia.md#de-onde-vêm-as-travas)).

## E o ChatGPT?

A memória de um aplicativo de IA fica dentro dele. Aqui ela é um arquivo de texto seu: você lê cada
linha, corrige o que quiser e aprova cada mudança antes de ela entrar, e o git guarda cada versão. O
vault aprende com as suas conversas com o Claude Code e, se você conectar, com a agenda e as notas de
reunião; o que você conta ao ChatGPT ele não vê.

No dia a dia, você conversa com o Claude Code no terminal, na pasta do vault, e aprova os pull
requests no GitHub, até pelo celular. Contar uma novidade ao vault, por enquanto, é no computador.

## O que você ganha

- **Memória que não some.** O que você contou ao Claude sobre a reunião da semana passada está numa nota, e não na boa vontade da IA.
- **Atualização que chega sozinha.** Ligado o curador, todo dia ele lê as suas conversas da véspera com o Claude Code e, se você conectar, a agenda e as notas de reunião, e abre o pull request por você.
- **Nada muda sem você.** Toda mudança é um pull request que você aprova no GitHub, até pelo celular, na fila do pão.
- **Um briefing de manhã.** O que vence hoje, o que atrasou e o que espera a sua aprovação, num resumo só.
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
- não quer assinar um plano pago do Claude e passar a conversar com ele pelo Claude Code;
- usa Windows: este passo a passo é para o terminal do Linux e do macOS, os únicos testados, e o curador agendado não roda no Windows.

Nunca usou o terminal? Tudo bem: o [passo zero](docs/preparar-o-computador.md) ensina, e é copiar e colar.

## Como funciona

1. **Você trabalha.** Você abre o Claude Code na pasta do vault (o passo 8 mostra como) e conversa normalmente. O que você pede para registrar, ele anota no log e nas notas, e no fim da resposta o kit lembra a ele de propor a mudança para você aprovar.
2. **O curador lê e propõe.** No horário que você escolher (ou quando você pedir), o curador faz uma rodada, uma passada pelas novidades. Ele lê as conversas dos dias que ainda não leu, sempre até ontem, porque hoje ainda não terminou; anota no log, o diário do vault, o que elas trouxeram de novo; atualiza as notas; confere tudo e abre um pull request.
3. **Você aprova.** Lê o pull request no GitHub e faz o merge, o clique que aprova. É a única porta de entrada do vault.

O curador não navega na internet nem lê o resto do computador, e é instruído a nunca inventar:
o que não está numa fonte que ele leu, ele não sabe. Instrução não é garantia, e IA erra; é por
isso que nada entra sem o seu merge.

De manhã, o briefing conta como o vault está: o que vence hoje, o que atrasou, os pull requests
esperando você e as perguntas que ele precisa que você responda. Com horário, ele aparece nos dias
úteis numa conversa do aplicativo Claude para desktop; sem horário, você pede numa conversa no vault.

### Palavras que você vai ver

| Palavra | O que quer dizer |
|---|---|
| terminal e `cd` | a janela onde você digita comandos; o `cd` entra numa pasta, e `cd ~/my-brain` entra no vault |
| git e GitHub | o git anota cada versão dos arquivos; o GitHub guarda uma cópia na internet |
| repositório | uma pasta com esse histórico; o vault é um |
| commit e push | um commit é um ponto salvo no histórico; o push envia os commits ao GitHub |
| pull request e merge | o pedido de mudança que você lê no GitHub, e o clique que o aprova |
| branch | uma versão paralela das notas, onde uma mudança espera a sua aprovação; a principal se chama `main` ou `master` |
| vault | a pasta das suas notas, o seu segundo cérebro |
| log | o diário do vault: cada novidade numa linha com data; as notas são escritas a partir dele |
| curador e rodada | a IA que mantém o vault em dia, e cada passada dela pelas novidades |
| trava de push | a conferência que roda antes de cada push e barra senhas e códigos de acesso secretos |
| plugin e marketplace | o plugin é um complemento do Claude Code; o marketplace, a lista de onde ele o instala |
| skill | uma instrução pronta que o Claude segue quando você pede, como a `capture`, que registra uma novidade |
| hook | um programa que roda sozinho quando algo acontece, como no fim de cada resposta do Claude |

## Como fica na prática

Um exemplo inventado. Na quinta, 01/10/2026, você conta ao Claude Code, na pasta do vault, que na
reunião de hoje o Carlos Mendes, um cliente, pediu a proposta revisada até sexta. O Claude anota
uma linha no log, `memoria/log.md`:

```markdown
**Captura** Na reunião de 01/10/2026, o cliente Carlos Mendes pediu a proposta revisada até sexta, 02/10/2026.
```

No fim da resposta, ele transforma essa linha numa pendência com o prazo e numa nota do Carlos, e
abre o pull request "curadoria: pedido do Carlos Mendes". A nota só tem o que a linha diz:

```markdown
# Carlos Mendes

Cliente.

- 01/10/2026: pediu a proposta revisada até sexta, 02/10/2026.
```

Em cima, o arquivo leva um pequeno cabeçalho que o kit preenche (o tipo da nota, um resumo, quem a
escreveu e quando). Depois do merge, o briefing de sexta de manhã traz, entre outras coisas:

```text
Atrasadas e para hoje
- Mandar a proposta revisada para o Carlos Mendes: vence hoje.
Perguntas
- A proposta revisada já foi para o Carlos Mendes?
```

## Quanto custa

O kit é grátis e de código aberto (licença MIT: use, copie e mude à vontade). O que custa é o
Claude: o Claude Code pede um plano pago. Em 02/10/2026, a [página oficial de preços](https://claude.com/pricing)
dizia: o plano grátis não inclui o Claude Code; o mais barato que inclui, para uma pessoa, é o
Pro, de US$ 20 por mês, ou US$ 200 por ano cobrados de uma vez (que a página apresenta como US$ 17
por mês); o Max começa em US$ 100 por mês; e os preços não incluem impostos.

Numa assinatura, não há cobrança por rodada: o plano tem um limite de uso só, e o curador gasta dele
como as suas conversas; quanto, o projeto ainda não mediu. Se o limite acabar, ele acaba também para
as suas conversas, e a rodada daquele dia fica para a próxima, sem perder nada. Uma rodada sem nada
para ler termina sem chamar a IA e não gasta nada. Com uma chave de API (a conta de desenvolvedor,
paga por uso), cada rodada é cobrada à parte: [quanto, no guia](docs/guia.md#quanto-custa-uma-rodada).

## Privacidade

Por padrão, o curador guarda tudo o que as suas conversas, a agenda e as notas de reunião ensinam
ao vault, inclusive informação pessoal e sensível (saúde, família, finanças), a sua e a de outras
pessoas. Por isso o repositório precisa continuar privado: só você e quem você convidar o veem.

Para guardar menos, peça ao Claude Code, dentro do vault, algo como "guarde só um resumo do que
for sensível sobre as outras pessoas". Ele muda a configuração, e a mudança vira um pull request
como qualquer outra; os níveis e o arquivo estão [no guia](docs/guia.md#privacidade-o-que-o-curador-guarda).
É uma instrução ao curador, não uma garantia: você confere no pull request o que ele escreveu.

Pela LGPD, o que você anota sobre outras pessoas é dado pessoal. Saúde, religião, vida sexual e
opinião política, entre outros, são dados sensíveis. Quem responde por eles é você, o dono do
vault: anote dos outros só o que tem motivo para guardar. Com dados da empresa, confira antes a
política dela. O kit não tem servidor: o que a IA lê passa pela sua conta do Claude, e num plano
Pro ou Max o uso das suas conversas para treinar os modelos da Anthropic depende de uma opção sua,
nas [configurações de privacidade](https://claude.ai/settings/data-privacy-controls) ([a política](https://code.claude.com/docs/en/data-usage)).

## Em que pé está

<!-- status-reviewed: 0.0.10 -->

O kit está em construção, mas o vault de referência, usado todo dia, já roda pelo kit, e desde
01/10/2026 também o curador agendado e o briefing. Cada versão é uma tag do git (um marcador de
versão). A tag mais recente é a `v0.0.10`. O pacote `second-brain-kit` no site do npm é um esqueleto
antigo, a 0.0.1: o passo 1 usa o npm de outro jeito e instala a versão certa. Os comandos do passo a
passo foram testados pelo projeto, mas ninguém de fora fez o caminho todo ainda: você estaria entre os
primeiros. Se travar, [abra uma issue](https://github.com/aleckyann/brain-kit/issues) com a mensagem
que apareceu na tela, ou peça ajuda a quem mandou o link. Cada fase está no [guia](docs/guia.md#status).

## O que você precisa

Nunca instalou nada disso? [Comece por aqui](docs/preparar-o-computador.md): o passo zero, para
Mac e Linux, começa pelas duas contas e mostra como abrir o terminal e instalar cada item.

- **Node.js 22 ou mais novo (o 24 LTS é o recomendado)**, o motor que roda o kit; LTS é a versão de suporte longo: [nodejs.org](https://nodejs.org).
- **git**, que guarda o histórico das notas: [git-scm.com](https://git-scm.com/downloads).
- **Uma conta no GitHub**, grátis, com repositórios privados à vontade: [github.com/signup](https://github.com/signup).
- **O `gh`**, o GitHub no terminal: [cli.github.com](https://cli.github.com).
- **O Claude Code**, com um plano pago do Claude: [code.claude.com](https://code.claude.com/docs/en/overview) (em inglês).

Com tudo isso já instalado, conte com cerca de 35 minutos até o primeiro pull request: uns 10 de
leitura, uns 20 nos passos abaixo e mais alguns para aprovar no GitHub. São estimativas, não uma
promessa, e não incluem o passo zero.

## Passo a passo

Os onze primeiros passos montam o vault e o primeiro pull request aprovado; o décimo segundo é a
prova. Cada um diz o que faz, o comando para colar no terminal e o que deve aparecer. Algumas
mensagens saem em inglês mesmo num computador em português: cada passo diz qual procurar.

> **Do passo 5 em diante**, sempre que abrir um terminal novo, comece com `cd ~/my-brain`. O `cd`
> entra numa pasta, e os comandos do vault só funcionam de dentro dela.

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

   Passa muito texto, parte em inglês; é normal. Quando o terminal parar, confira:

   ```bash
   brain-kit --version
   ```

   Deu certo se aparecer um número de versão (não confie só no `Successfully installed` do plugin, que aparece mesmo quando o npm falha). Se aparecer `command not found`, siga [Se aparecer `EACCES`](#se-aparecer-eacces), que resolve os dois. A pasta `brain-kit` que a primeira linha baixou não é mais usada: apague-a, ou ela atrapalha a próxima atualização (num terminal recém-aberto, ela fica na sua pasta de usuário, que o Finder do Mac abre com Command + Shift + H). Já a pasta `~/.local/share/brain-kit/`, que o trecho cria, **não pode ser apagada**: é dela que o Claude Code carrega o plugin.
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

   Ele faz sete perguntas, uma de cada vez, cada uma com uma sugestão entre colchetes. Em "Primeiro nome", digite o seu. Em todas as outras, aperte Enter: "Idioma", "Apelido curto" (o nome curto que vai nas suas aprovações), "Título do vault", "Repositório no GitHub" (fica "ainda não": o passo 6 cria o `my-brain`), "O repositório precisa ser privado" (sim) e "Fuso horário" (o do seu computador). No fim, ele diz que conferiu o vault sem achar problema ("nenhuma ocorrência") e que ainda não salvou nada no histórico: é normal, isso é o passo 5.
5. <a id="passo-5"></a>**Faça o primeiro commit**, o primeiro ponto salvo no histórico. Se é a primeira vez que você usa o git neste computador, diga antes a ele quem você é. No terminal não dá para clicar no meio da linha, então cole as duas linhas abaixo num editor de texto, troque `Seu Nome` e `voce@example.com` pelos seus sem apagar as aspas (o e-mail da conta do GitHub serve) e cole o resultado no terminal. Se errar, rode a linha de novo com o certo.

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
8. **Abra o Claude Code dentro do vault:**

   ```bash
   claude
   ```

   Se você ainda não entrou na sua conta do Claude, ele abre o navegador para isso. Se perguntar se você confia nesta pasta, responda que sim. Está pronto quando aparece a caixa para você escrever.
9. **Conte a primeira novidade**, uma promessa de verdade. Peça ao Claude algo como "Registre no log que prometi mandar o feedback para a Ana até sexta": a skill `capture` escreve a entrada com a data no log do vault, `memoria/log.md`. Ele mostra a mudança e pede licença para editar o arquivo: aprove com Enter no **Yes**. Deu certo quando ele diz, numa linha, o que registrou.
10. **O Claude abre o primeiro pull request.** Quando ele termina a resposta, o kit lembra a ele de conferir o vault e propor a mudança. Ele pede licença para rodar alguns comandos do `brain-kit`, como o `propose`: pode aprovar, com Enter no **Yes**. Deu certo quando aparece `Pull request aberto` e o endereço do pull request no GitHub. Se ele terminar a resposta sem isso, saia do Claude Code (digite `exit`) e rode no terminal, na pasta do vault:

    ```bash
    brain-kit propose "Primeira captura" --only memoria/log.md
    ```

    > **Regra de ouro:** daqui para frente, quem salva no histórico é o `propose`, e o que ele salva só entra no vault quando você faz o merge no GitHub. Não faça commit dos arquivos do vault você mesmo: é pagar o boleto duas vezes e dar confusão depois (o `sync` recusa, dizendo que os branches divergiram).
11. <a id="passo-11"></a>**Aprove no GitHub.** Copie o endereço que o `propose` mostrou e abra no navegador. Na aba **Files changed**, as linhas em verde são o que entra no vault. Se estiver certo, clique em **Merge pull request** e depois em **Confirm merge** (o GitHub é em inglês). É a sua aprovação, e a única forma de o vault mudar. Depois, saia do Claude Code (digite `exit`), se ele estiver aberto, e rode no terminal, na pasta do vault:

    ```bash
    brain-kit sync
    brain-kit verify --pr 1
    ```

    O `sync` vale para todo merge, até o que você fizer pelo celular: rode-o antes de voltar a mexer no vault, para trazer o que você aprovou. O `verify` é opcional: marca como verificadas as notas que você aprovou (o Claude avisa quando usa uma que ainda não foi), e quando carimba alguma, faz um commit e mostra o comando de push para você rodar. Se o pull request só mexeu no log (o log não é uma nota), ele diz "nada a carimbar, e nada foi escrito": é isso mesmo. O número do primeiro pull request é 1; nos próximos, use o que vem depois de `/pull/` no endereço.
12. **A prova.** Abra o Claude Code de novo (`claude`) e pergunte "o que eu prometi esta semana?". O kit pede a ele que responda a partir das notas e diga o caminho de onde tirou (é a skill `ask`), como o `memoria/log.md` ou o `pendencias/promessas.md`. Quando o vault não tem a resposta, ele deve dizer que não sabe em vez de inventar; o caminho citado é o que você confere.

Pronto: esse é o vault com a aprovação por pull request; o curador e o briefing são o
[depois, se você quiser](#em-30-segundos). Outra máquina? [O guia tem o caminho](docs/guia.md#o-mesmo-vault-em-uma-segunda-máquina).

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
