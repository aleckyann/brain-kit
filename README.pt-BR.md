# brain-kit

> Em construção. A fase 1 está concluída: o validador, o linter, os gates de push, o
> `init`, o `init --adopt`, o `update`, o `doctor`, o loop de pull request (`sync`,
> `propose`, `verify`) e o plugin do Claude Code (hooks, skills, um subagente somente
> leitura) já funcionam hoje, a partir de um clone deste repositório. A fase 2 também está
> concluída: o curador agendado (`curate`, `watermark`, `schedule`) lê as suas sessões
> recentes do Claude Code e abre um pull request a partir de uma rodada sem ninguém por
> perto. A fase 3 também está concluída: a rodada lê ainda a sua agenda e as suas notas de
> reunião pelos conectores do claude.ai, depois que você os liga. A fase 4 está em
> revisão: o briefing matinal (`preflight`, `questions`, a skill `briefing` e a tarefa dela
> no aplicativo para desktop). O pacote no npm ainda é o esqueleto da fase 0. Acompanhe o
> repositório para a primeira versão usável.

Um segundo cérebro em markdown puro, no Open Knowledge Format (OKF) v0.2, mantido por um
agente de IA que o lê por um índice, o alimenta todo dia a partir do seu próprio trabalho
(transcripts de sessão, agenda, notas de reunião) e só o altera por pull request. O seu
merge é a aprovação e a verificação.

O brain-kit é um repositório que pretende ser, ao mesmo tempo:

- um pacote npm, `second-brain-kit`, com um único executável, `brain-kit`. Hoje ele
  cria um vault ou adota um existente, instala o gate de push dele, mantém atualizados os
  arquivos do próprio kit, confere a máquina com o `doctor`, valida e aplica lint a um
  vault, roda o loop de pull request (`sync`, `propose`, `verify`) e roda o curador
  agendado (`curate`, `watermark`, `schedule`) e os fatos e a fila de perguntas do
  briefing matinal (`preflight`, `questions`);
- um plugin do Claude Code (nove skills, os hooks Stop e SessionStart, um subagente
  somente leitura) que chama o mesmo motor;
- um marketplace de um plugin só, para que `claude plugin marketplace add aleckyann/brain-kit`
  seguido de `claude plugin install brain-kit@brain-kit` o instale.

O registro do npm recusou o nome `brain-kit`: já existe lá um pacote sem relação chamado
`brainkit`, e os dois foram considerados parecidos demais. Por isso o pacote é publicado
como `second-brain-kit`, enquanto o repositório, o plugin, o marketplace e o comando que
você digita depois se chamam todos `brain-kit`.

O motor é Node.js 24 sem nenhuma dependência, de runtime ou de desenvolvimento. O vault
que ele gera é seu: markdown, frontmatter YAML e um arquivo de configuração declarativo,
nada mais.

## O que funciona hoje

Todo comando roda a partir de um clone. Um vault é um diretório com um
`brain-kit.config.json` e um `index.md` na raiz; os comandos recebem o caminho dele, ou o
encontram subindo a partir do diretório atual.

```bash
git clone https://github.com/aleckyann/brain-kit.git
node brain-kit/bin/brain-kit.mjs init caminho/do/vault-novo
node brain-kit/bin/brain-kit.mjs init --adopt caminho/do/vault-existente
node brain-kit/bin/brain-kit.mjs update caminho/do/vault
node brain-kit/bin/brain-kit.mjs doctor caminho/do/vault
node brain-kit/bin/brain-kit.mjs validate caminho/do/vault
node brain-kit/bin/brain-kit.mjs lint caminho/do/vault
node brain-kit/bin/brain-kit.mjs sync caminho/do/vault
node brain-kit/bin/brain-kit.mjs propose "resumo" --only notas/alterada.md
node brain-kit/bin/brain-kit.mjs verify --pr 12
node brain-kit/bin/brain-kit.mjs curate caminho/do/vault
node brain-kit/bin/brain-kit.mjs watermark show caminho/do/vault
node brain-kit/bin/brain-kit.mjs schedule install caminho/do/vault
node brain-kit/bin/brain-kit.mjs preflight caminho/do/vault
node brain-kit/bin/brain-kit.mjs questions list caminho/do/vault
node brain-kit/bin/brain-kit.mjs schedule install --job briefing caminho/do/vault
```

O `init` cria um vault novo num diretório vazio ou novo, em inglês ou português: o
esqueleto, a configuração, um `.gitignore`, o gate de push (`.githooks/pre-push`, com o
`core.hooksPath` apontando para ele), um manifesto do que o kit escreveu, um repositório
git, e o `machine.json` num diretório de estado fora do vault. Ele faz uma pergunta por
vez, aceita `--yes` ou `--from-answers <arquivo>` no lugar, e nunca faz o primeiro commit
a menos que isso seja pedido.

O `init --adopt` traz um vault existente para o kit. O vault precisa já ser um repositório
git (escreva o `.gitignore` dele e depois rode `git init`); uma pasta que não é um é
recusada sem nada escrito. Ele deduz a configuração das notas que o git publicaria (uma
pasta ou nota que o git ignora não contribui com nada) e mostra cada dedução,
escreve a configuração e um manifesto que registra como seus, só pelo caminho, os arquivos
que o git publicaria (um arquivo que o git ignora nunca é registrado, e nenhum hash do seu
conteúdo é guardado), e instala o gate de push. Um hook seu, ou um `core.hooksPath` apontando para outro lugar, fica
exatamente como está, e o adopt mostra a linha que acrescenta o gate a ele. `--no-hook`
pula o gate. Ele nunca muda uma nota e nunca faz commit.

O `update` atualiza por checksum os arquivos que o kit gerencia (os arquivos de contrato
da raiz, o `.gitignore` e o hook): um que você não editou é substituído, um que você
editou nunca é sobrescrito, e uma versão mais nova é escrita ao lado como
`<nome>.brain-kit-new`. O `update --install-hook` instala o gate de push num vault que não
o tem, com o mesmo cuidado com um hook seu.

O `doctor` informa, verificação por verificação, se esta máquina e este vault estão
prontos: Node e git, o gate e o `core.hooksPath`, o `brain-kit` no PATH, a configuração, o
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
aplicativo para desktop. Cada falha nomeia o comando que a corrige.

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
diz o que rodar. O `verify` é o comando do dono depois do merge: carimba `verified` nas
notas que o pull request mergeado alterou e faz o commit com a identidade do próprio dono.
O `machine` mostra e edita o `machine.json` local da máquina.

## O curador agendado

O `curate` roda uma rodada: lê as sessões do Claude Code dos projetos que a sua
configuração lista, escolhidas pelo horário das mensagens, e as entrega a um modelo que só
consegue agir pelos próprios `validate`, `lint` e `propose` do kit. A rodada termina num
pull request contra o seu vault. O modelo roda isolado das suas próprias configurações do
Claude Code: nenhum arquivo de configuração seu ou do projeto é carregado, nenhum hook,
nenhum servidor MCP, nenhuma skill e nenhuma ferramenta nativa além das sete de que ele
precisa; ele lê só o vault e os transcripts que a rodada lista, e tudo o que as regras da
própria rodada não permitem é negado. A rodada confere o isolamento pelo primeiro evento
da CLI e para o modelo se ele não se confirmar. Os passos rodam numa ordem fixa e testada (lock, rede, sync, e só então a
configuração já sincronizada), e toda forma de uma rodada falhar termina com uma saída
diferente de zero, um motivo no `last-run.json` e no log, e o seu comando de notificação. O
`--dry` mostra o que uma rodada faria e o `--check` roda todos os passos até o modelo.

O `watermark` mostra e move o último dia varrido de cada fonte. Cada fonte lê os dias
seguintes à própria marca, os mais antigos primeiro e inteiros (quantos couberem em
`curate.caps.transcripts`; os demais ficam para a próxima rodada), e a marca dela só anda
quando o registro da rodada mostra a fonte lida e o modelo a informou; nenhum dia é
fechado sem ter sido lido. O
`schedule install|uninstall|status` instala a rodada em janelas diurnas (09:30, 14:00 e
20:00 por padrão), com um nome que diz o que ela faz e sem depender de nenhum alvo de rede:
os timers de usuário do systemd são a referência, e launchd e cron também são gerados.

O [docs/scheduling.md](docs/scheduling.md) explica a rodada passo a passo, as janelas, a
marca d'água, os códigos de saída e o que fazer em cada um. O
[docs/security.md](docs/security.md) explica o que isola o modelo e as medições por trás
disso.

## Agenda e notas de reunião

Uma rodada também pode ler a sua agenda, pelo conector Google Calendar do claude.ai, e as
suas notas de reunião, pelo conector Google Drive do claude.ai. As duas fontes ficam
desligadas até você ligá-las: a agenda, nomeando as agendas a ler; as notas de reunião,
copiando de um documento seu o título literal das suas notas automáticas, com os acentos.
As duas são best effort: uma rodada que não consegue ler uma delas deixa o dia dessa fonte
aberto e ainda cura e propõe o resto, e nenhuma das duas consegue escrever nada pelo seu
conector.

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
instrução), e um overlay de prompt pode trocar o prompt inteiro.

Toda data, contagem e prazo que ele traz é calculado pelo kit: o `preflight` imprime os
mesmos fatos, lendo as tabelas de pendências pelo nome da coluna e pondo cada item num
balde pela primeira data real da célula, com "sem data" como balde próprio e o que for
ambíguo nomeado junto do item. O julgamento é do modelo. O kit nunca põe no prompt o
conteúdo de um caminho em `briefing.never_read`: um caminho que ele precisa citar, como
uma nota vencida, vem marcado "(nunca lido)", e as verificações dele só leem o que o
`validate` sempre leu, o frontmatter de cada nota. O modelo recebe a instrução de nunca
abrir, listar ou buscar esses caminhos; é uma instrução ao modelo, não uma caixa de
areia. Nenhum limite vale se você não definir um (`max_words`, `max_questions` e
`write_caps` são `null` por padrão), e `briefing.enabled: false` desliga o briefing no
vault.

O `questions` guarda a fila de perguntas abertas de uma manhã para outra: sem duplicatas
pelo texto normalizado, escaladas depois de feitas em três dias e arquivadas depois de 45
dias (os dois por padrão) pelo `questions sweep`, que imprime cada uma que arquiva. O que
você responde, e o que o briefing captura, vira um único pull request pelo `propose
--only`; sem nada a registrar, não há pull request. O `schedule install --job briefing`
imprime a tarefa a criar no aplicativo Claude para desktop, que a skill `setup` registra
para você; ela roda enquanto o aplicativo está aberto, e na próxima abertura dele quando
estava fechado. Uma sessão que começa com o prompt da tarefa nunca chega ao curador; um
briefing que você pede numa sessão sua é seu, e o curador o lê. O
[docs/briefing.md](docs/briefing.md) explica os blocos, os fatos e de onde cada um vem, a
fila, a tarefa no aplicativo e o que nunca muda.

Ainda não medido: se o aplicativo para desktop entrega o prompt da tarefa à sessão como a
primeira mensagem do usuário, sem mudança. O curador só descarta a sessão da tarefa se ele
fizer isso. Se o aplicativo embrulhar o prompt (uma linha de invocação de skill, um
cabeçalho), a sessão é lida como uma sua: o custo é o de um briefing que você mesmo pede
(uma captura que a próxima rodada pode propor de novo, visível no diff, nada se perde), e
só quando o diretório de trabalho da tarefa é um projeto listado em
`sources.transcripts.include_projects`. Depois da primeira execução agendada, o `brain-kit
curate --dry` mostra o plano das transcrições e quantas sessões ele deixou de fora como do
próprio kit.

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

| Fase | Conteúdo | Estado |
|---|---|---|
| 0 | Esqueleto, códigos de saída, packs de idioma, schemas de config, trava anti-vazamento, CI, docs | concluída, 0.0.1 no npm |
| 1 | Validador, lint, propose (loop de PR), hook Stop, init, doctor, skills | concluída |
| 2 | Curador agendado sobre transcripts locais, templates de agendamento | concluída |
| 3 | Fontes de agenda e notas de reunião (best effort por desenho) | concluída |
| 4 | Briefing matinal | em revisão |
| 5 | Migração do vault original para o kit | planejada |
| 6 | Publicação 0.1.0 | planejada |
| 7 | Outras forjas, outros harnesses, mais fontes, cada um só quando um segundo caso real precisar | planejada |

A fase 1 é construída em cinco fatias:

| Fatia | Conteúdo | Estado |
|---|---|---|
| 1A | Leitor de vault, frontmatter, markdown, `validate` | concluída |
| 1B | `lint` e suas oito regras, o scanner de vazamento, os dois gates de push | concluída |
| 1C | `propose` (o loop de PR) e `sync` | concluída |
| 1D | `init`, `init --adopt`, `update`, `doctor` | concluída |
| 1E | Superfície do plugin: skills, hooks Stop e SessionStart, subagente somente leitura, evals | concluída |

## Segurança

Existem dois gates de push, com alcances diferentes. O gate deste repositório varre todo
objeto que um push carrega contra uma lista pessoal de padrões mantida fora do repositório.
O hook de template feito para um vault, em `templates/githooks/`, roda `validate` e `lint`
sobre a árvore de trabalho e depois a mesma varredura de objetos sobre o que o push carrega,
contra os padrões configurados do próprio vault, os da árvore de trabalho, os de cada ponta
enviada e os do branch padrão juntos. O `init` o instala em todo vault novo, o
`init --adopt` num vault existente a menos que já haja lá um hook da própria pessoa, e o
`brain-kit update --install-hook` depois. Uma recusa por correspondência termina dizendo o
que fazer: revogar a credencial, tirá-la do histórico e seguir o `SECURITY.md` do vault. O
[SECURITY.md](SECURITY.md) lista o que os gates não cobrem.

## Contribuindo

Leia primeiro o [CONTRIBUTING.md](CONTRIBUTING.md). Todo clone precisa rodar
`.githooks/install-gate` uma vez, senão aquele clone não tem gate anti-vazamento nenhum.

## Por quê

Leia [docs/rationale.md](docs/rationale.md) para o raciocínio e
[docs/incidents.md](docs/incidents.md) para as falhas datadas que produziram cada guarda.

## Requisitos (alvo)

Node.js >= 24, git, a CLI do GitHub (`gh`) autenticada e o Claude Code; para as fontes de
agenda e de notas de reunião, os conectores Google Calendar e Google Drive do claude.ai,
conectados no claude.ai e ativados para o Claude Code; para o briefing com horário, o
aplicativo Claude para desktop. Linux é a
plataforma de referência para agendamento (timers de usuário do systemd, que precisam de
`loginctl enable-linger` para rodar com você deslogado); as entradas de macOS (launchd) e
cron são geradas e testadas sem que a suíte de testes as instale; Windows fica fora do
escopo de agendamento.

## Licença

MIT. README em inglês: [README.md](README.md).
