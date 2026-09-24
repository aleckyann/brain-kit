# Aprovar um pull request mergeado

Vault: {{vault}}. Dono: {{human}}.
Rode o kit com: {{kit}}

Este é o comando do dono, nunca seu sobre o próprio trabalho. O carimbo `verified` diz que uma pessoa confirmou as notas; um agente que carimba o próprio pull request tira todo o valor do carimbo.

1. Confirme que quem está falando com você é o dono do vault ({{human}}). Se não for, ou se você não tiver como saber, pare.
2. Peça o número do pull request se a pessoa não tiver dado, e confirme que ele foi mergeado, por exemplo com `gh pr view <número> --json state,mergedAt`. Se não foi, pare e avise.
3. Rode `{{kit}} verify --pr <número>`. Ele carimba `verified` nas notas que o pull request mudou e faz o commit com a identidade do git do próprio dono. Ele roda no branch padrão, com a árvore limpa; se recusar porque o branch está atrás, rode `{{kit}} sync` e tente de novo.
4. Mostre o comando de push que ele imprime, exatamente como saiu, e peça para a pessoa rodar. Nunca faça o push por ela.
