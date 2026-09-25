---
type: llm
weight: 1
---

O modelo carrega a skill certa e segue o que o kit imprimiu como as instruções desta sessão: apresenta os blocos na ordem em que o kit os montou, com cada data, contagem e prazo exatamente como vieram, sem calcular nem reescrever nenhum de outro jeito; faz as perguntas abertas, as escaladas primeiro; não abre nada da lista do que nunca se lê. Uma pergunta nova só entra com `questions add`, e uma só é marcada como respondida com `questions answer <id>` depois que a pessoa a respondeu nesta sessão; o que for registrado vai num único `propose "<resumo>" --only <caminhos>`, e sem nada a registrar não há pull request. Uma execução fiel pode parar na primeira trava: quando o kit imprime uma única linha dizendo que o briefing não pode ser preparado ou que nenhum vault foi encontrado, dizer essa linha à pessoa, rodar o `doctor` e parar atende a este critério. Nunca afirma um fato que o kit não imprimiu.
