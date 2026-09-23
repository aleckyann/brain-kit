# brain-kit

> Em construção. A fase 1 está em andamento: `init`, `init --adopt`, `update`, `doctor`, o
> validador, o linter e os gates de push já funcionam hoje, a partir de um clone deste repositório. Nada aqui cura um vault ainda, e o pacote no npm ainda é o esqueleto
> da fase 0. Acompanhe o repositório para a primeira versão usável.

Um segundo cérebro em markdown puro, no Open Knowledge Format (OKF) v0.2, mantido por um
agente de IA que o lê por um índice, o alimenta todo dia a partir do seu próprio trabalho
(transcripts de sessão, agenda, notas de reunião) e só o altera por pull request. O seu
merge é a aprovação e a verificação.

O brain-kit é um repositório que pretende ser, ao mesmo tempo:

- um pacote npm, `second-brain-kit`, com um único executável, `brain-kit`. Hoje ele
  cria um vault ou adota um existente, instala o gate de push dele, mantém atualizados os
  arquivos do próprio kit, confere a máquina com o `doctor`, e valida e aplica lint a um
  vault; o loop de PR, o curador, o pré-voo do briefing e os templates de agendamento
  ainda estão por vir;
- um plugin do Claude Code (skills, um hook Stop, um subagente somente leitura) que chama o
  mesmo motor. Hoje o repositório traz só o manifesto do plugin e o encaixe do hook, e o
  hook ainda não faz nada;
- um marketplace de um plugin só, para que `claude plugin marketplace add aleckyann/brain-kit`
  o instale quando a superfície do plugin chegar.

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
```

O `init` cria um vault novo num diretório vazio ou novo, em inglês ou português: o
esqueleto, a configuração, um `.gitignore`, o gate de push (`.githooks/pre-push`, com o
`core.hooksPath` apontando para ele), um manifesto do que o kit escreveu, um repositório
git, e o `machine.json` num diretório de estado fora do vault. Ele faz uma pergunta por
vez, aceita `--yes` ou `--from-answers <arquivo>` no lugar, e nunca faz o primeiro commit
a menos que isso seja pedido.

O `init --adopt` traz um vault existente para o kit. Ele deduz a configuração das notas e
mostra cada dedução, escreve a configuração e um manifesto que registra como seus os
arquivos que o git publicaria (um arquivo que o git ignora nunca é registrado), e instala o
gate de push. Um hook seu, ou um `core.hooksPath` apontando para outro lugar, fica
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
`claude`, e o `node_modules/` no `.gitignore`. Cada falha nomeia o comando que a corrige.

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
| `privacy` | notas confidenciais ficam em diretórios confidenciais e não recebem link de diretórios compartilhados |
| `attribution` | as fontes de uma nota e as notas de rodapé dela se ancoram umas nas outras |

`--rule` restringe a rodada às regras nomeadas, `--base` escolhe o que conta como a
mudança (`auto`, `worktree`, `merge-base` ou `all`), e `--json` gera saída legível por
máquina. A regra `secrets` ignora o `--base` e sempre lê tudo o que um push poderia
publicar, porque uma credencial que já está lá é o achado de que um vault novo mais precisa.

## Status

| Fase | Conteúdo | Estado |
|---|---|---|
| 0 | Esqueleto, códigos de saída, packs de idioma, schemas de config, trava anti-vazamento, CI, docs | concluída, 0.0.1 no npm |
| 1 | Validador, lint, propose (loop de PR), hook Stop, init, doctor, skills | em andamento |
| 2 | Curador agendado sobre transcripts locais, templates de agendamento | planejada |
| 3 | Fontes de agenda e notas de reunião (best effort por desenho) | planejada |
| 4 | Briefing matinal | planejada |
| 5 | Migração do vault original para o kit | planejada |
| 6 | Publicação 0.1.0 | planejada |
| 7 | Outras forjas, outros harnesses, mais fontes, cada um só quando um segundo caso real precisar | planejada |

A fase 1 é construída em cinco fatias:

| Fatia | Conteúdo | Estado |
|---|---|---|
| 1A | Leitor de vault, frontmatter, markdown, `validate` | concluída |
| 1B | `lint` e suas oito regras, o scanner de vazamento, os dois gates de push | concluída |
| 1C | `propose` (o loop de PR) e `sync` | planejada |
| 1D | `init`, `init --adopt`, `update`, `doctor` | concluída |
| 1E | Superfície do plugin: skills, hooks Stop e SessionStart, subagente somente leitura, evals | planejada |

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

Node.js >= 24, git, a CLI do GitHub (`gh`) autenticada e o Claude Code. Linux é a
plataforma de referência para agendamento (timers de usuário do systemd); macOS (launchd)
e cron estão planejados; Windows fica fora do escopo de agendamento.

## Licença

MIT. README em inglês: [README.md](README.md).
