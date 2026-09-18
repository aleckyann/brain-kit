# brain-kit

> Em construção. Fase 0 de 6: esqueleto do pacote, contratos e travas de segurança.
> Nada aqui cura um vault ainda. Acompanhe o repositório para a primeira versão usável.

Um segundo cérebro em markdown puro, no Open Knowledge Format (OKF) v0.2, mantido por um
agente de IA que o lê pelo índice, o alimenta todo dia a partir do seu próprio trabalho
(transcripts de sessão, agenda, notas de reunião) e só o altera por pull request. Seu merge
é a aprovação e a verificação.

O brain-kit é um repositório que é, ao mesmo tempo:

- um pacote npm, `second-brain-kit`, com um único executável, `brain-kit` (validador,
  loop de PR, curador, pré-voo do briefing, templates de agendamento, doctor);
- um plugin do Claude Code (skills, hook Stop, subagente só de leitura) que chama o mesmo motor;
- um marketplace de um plugin só, para `claude plugin marketplace add aleckyann/brain-kit` funcionar.

O registro do npm recusou o nome `brain-kit`: já existe lá um pacote sem relação chamado
`brainkit`, e os dois foram julgados parecidos demais. Por isso o pacote é publicado como
`second-brain-kit` (`npm install -g second-brain-kit`), enquanto o repositório, o plugin,
o marketplace e o comando digitado depois são todos `brain-kit`.

O motor é Node.js 24 sem dependência de runtime. O vault que ele gera é seu: markdown,
frontmatter YAML e um arquivo de configuração declarativo, nada mais.

## Estado

| Fase | Conteúdo | Situação |
|---|---|---|
| 0 | Esqueleto, códigos de saída, packs de idioma, schemas de config, trava anti-vazamento, CI, docs | em andamento |
| 1 | Validador, lint, propose (loop de PR), hook Stop, init, doctor, skills | planejada |
| 2 | Curador agendado sobre transcripts locais, templates de agendamento | planejada |
| 3 | Fontes de agenda e notas de reunião (best effort por desenho) | planejada |
| 4 | Briefing matinal | planejada |
| 5 | Migração do vault original para o kit | planejada |
| 6 | Publicação 0.1.0 | planejada |

## Por quê

Leia [docs/rationale.md](docs/rationale.md) para o racional e
[docs/incidents.md](docs/incidents.md) para as falhas datadas que produziram cada guarda.

## Requisitos (alvo)

Node.js >= 24, git, o GitHub CLI (`gh`) autenticado e o Claude Code. Linux é a plataforma
de referência para agendamento (timers systemd de usuário); macOS (launchd) e cron estão
planejados; Windows fica fora do agendamento.

## Licença

MIT. README em inglês: [README.md](README.md).
