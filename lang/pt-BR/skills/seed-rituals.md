# Semear a tabela de rituais a partir da agenda

Hoje é {{today}}. Vault: {{vault}}.
Rode o kit com: {{kit}}

Você vai propor as linhas da tabela de ritmo semanal do vault a partir da agenda da pessoa: os compromissos que se repetem, seja uma aula, a reunião de pauta de um escritório, a orientação de um laboratório ou um grupo de leitura. A curadoria usa essa tabela para traduzir o título de um evento na nota que ele alimenta, por isso o título entra literal, como está na agenda. Nada entra no vault sem a pessoa ver e confirmar cada linha.

## O conector

1. Isto roda na sua sessão com a pessoa, com o conector de agenda desta sessão. Você só lê a agenda: nunca crie, altere, apague nem responda a um evento. A ferramenta que você usa é a `list_events` desse conector (na linha de comando, com o prefixo de `sources.calendar.tool_prefix` no `brain-kit.config.json`; outros clientes podem usar outro prefixo). Ela costuma vir adiada: carregue com o `ToolSearch` antes de chamar.
2. Se as ferramentas da agenda não estiverem nesta sessão, diga isso à pessoa e pare. Nunca contorne: nada de shell, de outra API ou de arquivo exportado, e nunca peça senha nem token. Se uma chamada falhar, diga o erro exatamente como veio e pare; não conclua nada que o erro não diga.

## Ler as últimas quatro semanas

3. Rode `{{kit}} sync`. Se ele recusar, pare e diga o porquê.
4. No `brain-kit.config.json`, leia `sources.calendar.calendars`: são as agendas da pessoa. Lista vazia quer dizer `primary`, a agenda principal dela.
5. Para cada agenda, chame `list_events` com todos estes parâmetros, sempre explícitos:
   - `calendarId`: a agenda;
   - `startTime`: 00:00 do dia 28 dias antes de hoje, e `endTime`: `{{today_iso}}T00:00:00`, os dois com o deslocamento de UTC do vault (em UTC-3, `-03:00`), e `timeZone`: o fuso de `vault.timezone`;
   - `eventType: ["DEFAULT"]`, que deixa de fora ausências, blocos de foco, local de trabalho e aniversários;
   - `pageSize: 250`.
6. Enquanto o resultado trouxer `nextPageToken`, chame de novo com os mesmos parâmetros e `pageToken` igual a esse valor. A agenda só termina quando vier uma página sem `nextPageToken`: a primeira página não é a agenda inteira.

## Achar os rituais

7. Um ritual é um evento que se repete: as ocorrências têm o mesmo `recurringEventId`, ou o mesmo título (`summary`) aparece pelo menos três vezes nas quatro semanas.
8. Nunca conte como ritual:
   - evento de agenda de outra pessoa, a menos que a configuração registre o consentimento (`sources.calendar.team_calendars_consent_noted: true`), e mesmo assim só os eventos de que a pessoa participa;
   - evento privado: marcado como privado na agenda, ou com um título que tenha uma palavra de `sources.calendar.privacy.exclude_keywords`. Deixe de fora sem copiar o título para lugar nenhum.
9. Para cada ritual, anote:
   - o título exatamente como está na agenda, letra por letra, sem traduzir nem resumir;
   - a cadência, tirada das datas (toda semana, a cada duas semanas, de segunda a sexta, uma vez por mês);
   - o horário de início e de fim, no fuso do vault;
   - o dono: o organizador (`organizer`), pelo nome; quando `organizer.self` for `true`, é a própria pessoa; se o evento só trouxer o e-mail, pergunte à pessoa que nome escrever;
   - os participantes fixos, os que aparecem em todas as ocorrências: quantos são, e os nomes só se a pessoa concordar.

## A tabela

10. O arquivo é o de `taxonomy.files.rituals` no `brain-kit.config.json`. Leia a linha de cabeçalho da tabela dele: são essas colunas, nessa ordem, que você preenche. Não suponha as colunas; se uma não corresponder a nada do passo 9, pergunte à pessoa o que vai nela. Se o arquivo não tiver tabela, diga isso e pare.
11. Na coluna do título, escreva o título literal entre aspas retas, com cada `|` escrito como `\|`. Um evento chamado `Grupo de leitura | Ana` vira `"Grupo de leitura \| Ana"`. Essa forma escapada, com as aspas, é a chave: tire o escape só para comparar com a agenda, e mantenha o escape para escrever e para procurar na tabela.
12. Um título que já está na tabela não entra de novo: procure a forma escapada, com as aspas, no texto cru do arquivo, sem interpretar a tabela. Títulos antigos sem aspas não casam com essa busca: mostre-os à pessoa na hora de pedir a confirmação.
13. Pergunte à pessoa qual nota cada ritual alimenta. A resposta vai na coluna dela, como link relativo à pasta do arquivo de rituais, para uma nota que existe; sem nota, escreva "nenhuma ainda" (ou o texto de `taxonomy.columns.rituals.labels.feeds_none`).

## Confirmar e propor

14. Mostre todas as linhas propostas, já no formato da tabela, e diga quais títulos ficaram de fora por já estarem nela. Peça confirmação e espere: a pessoa pode aprovar, corrigir ou recusar cada linha.
15. Escreva só as linhas confirmadas, no fim da tabela, e carimbe o frontmatter do arquivo com `generated: { by: {{agent}}, at: <data e hora ISO 8601 com o deslocamento de UTC> }`, trocando `<model>` pelo modelo que você está usando. Nunca escreva `verified`.
16. Rode `{{kit}} validate` e `{{kit}} lint` e corrija o que eles apontarem, até os dois passarem.
17. Rode `{{kit}} propose "<resumo em uma linha>" --only <o arquivo de rituais>`, só com esse arquivo. Passe o link do pull request à pessoa e pare. Nunca faça o merge.
