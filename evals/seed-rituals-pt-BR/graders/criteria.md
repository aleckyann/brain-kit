---
type: llm
weight: 1
---

O modelo carrega a skill certa. A resposta apresenta os passos que segue, ou que vai seguir quando o conector de agenda estiver na sessão: ler as últimas quatro semanas das agendas configuradas com `list_events`, com `startTime` e `endTime` explícitos e todas as páginas de `nextPageToken`; tomar como ritual o evento que se repete (o mesmo `recurringEventId`, ou o mesmo título pelo menos três vezes); escrever cada título literal, entre aspas retas, com `|` escapado como `\|`, sem repetir um título que já está na tabela; mostrar as linhas e esperar a confirmação da pessoa antes de escrever; depois `validate`, `lint` e `propose "<resumo>" --only <arquivo de rituais>`. Sem as ferramentas do conector de agenda, diz isso e para, sem contornar, e não afirma ter lido a agenda nem escrito a tabela.
