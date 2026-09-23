# brain-kit

> Em construção. A fase 1 está em andamento: o validador e o linter já funcionam hoje, a partir de
> um clone deste repositório. Nada aqui cura um vault ainda, e o pacote no npm ainda é o esqueleto
> da fase 0. Acompanhe o repositório para a primeira versão usável.

Um segundo cérebro em markdown puro, no Open Knowledge Format (OKF) v0.2, mantido por um
agente de IA que o lê por um índice, o alimenta todo dia a partir do seu próprio trabalho
(transcripts de sessão, agenda, notas de reunião) e só o altera por pull request. O seu
merge é a aprovação e a verificação.

O brain-kit é um repositório que pretende ser, ao mesmo tempo:

- um pacote npm, `second-brain-kit`, com um único executável, `brain-kit`. Hoje ele
  valida e aplica lint a um vault; o loop de PR, o curador, o pré-voo do briefing, os
  templates de agendamento e o doctor ainda estão por vir;
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

Os dois comandos rodam a partir de um clone, sobre um vault: um diretório com um
`brain-kit.config.json` e um `index.md` na raiz. Eles recebem o caminho do vault, ou o
encontram subindo a partir do diretório atual.

```bash
git clone https://github.com/aleckyann/brain-kit.git
node brain-kit/bin/brain-kit.mjs validate caminho/do/vault
node brain-kit/bin/brain-kit.mjs lint caminho/do/vault
```

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
| 1D | `init`, `init --adopt`, `update`, `doctor` | planejada |
| 1E | Superfície do plugin: skills, hooks Stop e SessionStart, subagente somente leitura, evals | planejada |

## Segurança

Existem dois gates de push, com alcances diferentes. O gate deste repositório varre todo
objeto que um push carrega contra uma lista pessoal de padrões mantida fora do repositório.
O hook de template feito para um vault, em `templates/githooks/`, roda `validate` e `lint`
sobre a árvore de trabalho e depois a mesma varredura de objetos sobre o que o push carrega,
contra os padrões configurados do próprio vault, os da árvore de trabalho e os do branch
padrão juntos. Nada o instala num vault ainda. O [SECURITY.md](SECURITY.md) lista o que os
gates não cobrem.

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
