# Preparar o computador

O passo zero do [README](../README.md): o que ter antes do passo a passo, no Mac e no Linux
(Ubuntu), pelo caminho oficial mais simples de cada programa. Primeiro as duas contas, depois o
terminal e os programas. Para cada programa: o que ele é, como instalar, o que aparece na tela e
como conferir. Se a conferência já mostrar um número, o programa já está aí: pule para o próximo.

Tudo aqui foi conferido nas páginas oficiais em 02/10/2026. Elas são em inglês e mudam com o
tempo; quando a tela for diferente do que está aqui, vale a página oficial. Não damos estimativa
de tempo para esta parte: depende da sua internet e do que o computador já tem.

## Antes de tudo, as duas contas

As contas se criam no navegador, antes de instalar qualquer coisa.

- **GitHub.** Crie a conta em [github.com/signup](https://github.com/signup). Em 02/10/2026, a
  [página de preços do GitHub](https://github.com/pricing) dizia que o plano Free custa US$ 0 e
  tem repositórios públicos e privados sem limite.
- **Claude.** Para começar, o Pro; os outros planos pagos também servem. O Claude Code entra com a
  mesma conta do site e do aplicativo do Claude, mas não no plano grátis: segundo a
  [página do Claude Code](https://code.claude.com/docs/en/setup), ele precisa de um plano Pro, Max,
  Team ou Enterprise, ou de uma conta do Console (a de API, paga por uso). Em 02/10/2026, a
  [página de preços](https://claude.com/pricing) dizia: Pro, US$ 20 por mês, ou US$ 200 por ano
  cobrados de uma vez (que a página apresenta como US$ 17 por mês); Max, a partir de US$ 100 por
  mês; os preços sem impostos; e o Claude Code divide os mesmos limites de uso do resto do plano.
  A assinatura se faz na própria página de preços. O que isso quer dizer para o kit está em
  [Quanto custa](../README.md#quanto-custa).

## O terminal

O terminal é a janela onde você digita comandos (o [guia oficial do Claude Code para quem nunca
usou um](https://code.claude.com/docs/en/terminal-guide) mostra o mesmo, em inglês).

- **No Mac:** aperte Command + espaço, digite `Terminal` e aperte Enter.
- **No Ubuntu:** aperte Ctrl + Alt + T, ou procure "Terminal" nos aplicativos.

Para copiar um comando desta página, use o botão de copiar que aparece no canto de cada bloco. Para
colar: Command + V no Mac, Ctrl + Shift + V no Ubuntu. Depois, aperte Enter. Quando um comando
pedir a senha do computador, digite e aperte Enter: nada aparece enquanto você digita, e é assim
mesmo. Quando esta página disser "abra um terminal novo", é uma janela nova: Command + N no Mac,
Ctrl + Alt + T no Ubuntu.

## No Mac

O Claude Code precisa do macOS 13 ou mais novo (no menu da maçã, "Sobre Este Mac" mostra a sua
versão).

### 1. git

O git guarda o histórico das suas notas. No Mac, ele vem com as ferramentas de linha de comando
da Apple, um dos caminhos que o [git-scm.com](https://git-scm.com/install/mac) indica:

```bash
xcode-select --install
```

Abre uma janela perguntando se você quer instalar as ferramentas: clique em Instalar e espere.
Se o terminal disser que elas já estão instaladas, ótimo. Confira:

```bash
git --version
```

Deu certo se aparecer `git version` e um número.

### 2. Node.js

O Node.js é o motor que roda o kit. Em [nodejs.org](https://nodejs.org/en/download), baixe o
instalador para macOS (o arquivo `.pkg`) da versão marcada LTS, a de suporte longo: em
02/10/2026 era a 24. Abra o arquivo e siga o instalador. Depois, abra um terminal novo e confira:

```bash
node --version
```

Deu certo se aparecer um número que começa com `v`, como `v24.21.0`.

### 3. Uma pasta sua para os programas

O instalador do Node guarda os programas numa pasta do sistema, onde o passo 1 do README costuma
esbarrar no erro `EACCES` (permissão negada). Evite de uma vez: diga ao npm (o instalador que
vem com o Node) para usar uma pasta sua, e ponha essa pasta no PATH, a lista de pastas onde o
terminal procura os comandos:

```bash
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Abra um terminal novo e confira:

```bash
npm config get prefix
```

Deu certo se aparecer o caminho da sua pasta de usuário terminando em `.local`, algo como
`/Users/seunome/.local`. Essa mesma pasta serve ao Claude Code, no item 5.

### 4. gh

O `gh` é o GitHub no terminal: o kit abre os pull requests com ele. Na
[página de versões do gh](https://github.com/cli/cli/releases/latest), em Assets, baixe o
arquivo que termina em `_macOS_universal.pkg` (em 02/10/2026, o `gh_2.102.0_macOS_universal.pkg`;
o número muda a cada versão). Ele abre o instalador do macOS: siga as telas até o fim, com a senha
do computador quando ele pedir. (Quem já usa o Homebrew pode rodar `brew install gh`, como mostra o
[cli.github.com](https://cli.github.com).) Abra um terminal novo e confira:

```bash
gh --version
```

Deu certo se aparecer `gh version` e um número.

### 5. Claude Code

O Claude Code é o Claude que roda no terminal. O [instalador oficial](https://code.claude.com/docs/en/setup)
é um comando só:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Passa bastante texto pela tela; no fim aparecem `Claude Code successfully installed!` e, na última
linha, `Installation complete!`. Abra um terminal novo e confira:

```bash
claude --version
```

Deu certo se aparecer um número seguido de `(Claude Code)`. Se aparecer `command not found`,
faltou o item 3. Para entrar na sua conta do Claude, rode `claude`: na primeira vez ele pede o
login e abre o navegador; siga as instruções da tela. Para sair do Claude Code, digite `exit` (ou
aperte Ctrl + D duas vezes).

## No Ubuntu

O Claude Code precisa do Ubuntu 20.04 ou mais novo.

### 1. git e curl

O git guarda o histórico das suas notas, e o curl baixa os instaladores dos próximos itens (um
Ubuntu recém-instalado pode vir sem ele). Os dois vêm do apt, o instalador de programas do
Ubuntu, que é o caminho que o [git-scm.com](https://git-scm.com/install/linux) indica para o git:

```bash
sudo apt update
sudo apt install git curl
```

Ele pede a sua senha e, depois, se pode continuar: aperte Enter. Confira:

```bash
git --version
```

Deu certo se aparecer `git version` e um número.

### 2. Node.js

Em [nodejs.org](https://nodejs.org/en/download), escolha Linux, a versão marcada LTS (em
02/10/2026, a 24) e o método nvm: a página mostra algumas linhas para colar, uma de cada vez.
Com o nvm, o erro `EACCES` do passo 1 do README não acontece. Depois, abra um terminal novo e
confira:

```bash
node --version
```

Deu certo se aparecer um número que começa com `v`, como `v24.21.0`.

### 3. gh

Na [página oficial de instalação no Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md),
copie o bloco da seção Debian (ele vale para o Ubuntu), cole no terminal e aperte Enter. Confira:

```bash
gh --version
```

Deu certo se aparecer `gh version` e um número.

### 4. Claude Code

O mesmo [instalador oficial](https://code.claude.com/docs/en/setup) do Mac:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

No fim aparecem `Claude Code successfully installed!` e, na última linha, `Installation complete!`.
Abra um terminal novo e confira com `claude --version`: deu certo se aparecer um número seguido de
`(Claude Code)`. Se aparecer `command not found`, ponha a pasta do Claude Code no PATH e abra um
terminal novo:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Para entrar na sua conta do Claude, rode `claude`: na primeira vez ele pede o login e abre o
navegador. Para sair, digite `exit`.

## Tudo pronto?

Num terminal novo, rode as quatro conferências:

```bash
node --version
git --version
gh --version
claude --version
```

Se as quatro mostrarem um número, volte ao [passo a passo do README](../README.md#passo-a-passo).
