---
type: llm
weight: 1
---

O modelo carrega a skill certa. A resposta diz os passos que a skill segue: ler as últimas quatro semanas das agendas configuradas com `list_events`, com `startTime` e `endTime` explícitos e todas as páginas de `nextPageToken`; tomar como ritual o evento que se repete (o mesmo `recurringEventId`, ou o mesmo título pelo menos três vezes); escrever cada título literal, entre aspas retas, com `|` escapado como `\|`, sem repetir um título que já está na tabela; mostrar as linhas e esperar a confirmação da pessoa antes de escrever; depois `validate`, `lint` e `propose "<resumo>" --only <arquivo de rituais>`. Uma execução fiel pode parar na primeira trava: quando não há vault ou não há conector de agenda na sessão, dizer o que falta e parar, contando o que a skill vai fazer, atende a este critério. Nunca contorna a falta do conector e não afirma ter lido a agenda nem escrito a tabela.
