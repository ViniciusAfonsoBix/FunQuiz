# Live Poll — estilo Kahoot (Workshop 4)

Servidor + cliente, **zero dependências** (só Node ≥ 18). A pergunta e as
alternativas aparecem **só na tela do apresentador**; no celular o participante vê
apenas as formas/letras coloridas e toca na sua resposta.

Várias apresentações rodam ao mesmo tempo no mesmo servidor: cada JSON enviado
cria uma **sala** com código próprio, protegida por senha, apagada 24 h depois da
última atividade.

## Rodar

```bash
npm start
```

| tela | URL |
| --- | --- |
| criar uma sala | `http://localhost:3000/host` |
| controlar uma sala | `http://localhost:3000/host?r=CODIGO` |
| participante (celular) | `http://SEU_IP:3000/play?r=CODIGO` |

Abrir `/host` mostra o formulário de **nova sala**: escolha o `.json` das
perguntas e uma senha. O servidor devolve o código e já leva para a tela de
controle. O lobby mostra **QR code + URL + código** — é isso que a plateia usa
para entrar; quem não conseguir ler o QR abre `/play` e digita o código.

No boot o servidor também cria uma sala a partir do `questions.json` do projeto,
para dar para brincar sem subir arquivo nenhum. O console imprime o código, a
senha e as URLs prontas.

Porta e arquivo de perguntas: `PORT=8080 QUESTIONS=outro.json npm start`

## Verificar

```bash
npm test
```

Sobe servidores isolados e roda ~100 verificações em cerca de 20 s: o fluxo
completo de uma sala, o roteamento por código, a autenticação, o isolamento
entre duas salas simultâneas, os tetos e a persistência. Sem framework e sem
dependências, como o resto do projeto.

## Idiomas

A interface fala **português, inglês e espanhol**. Na primeira visita o idioma
sai do navegador (`navigator.languages`, comparando só a base: `pt-BR` e `pt-PT`
caem em `pt`); sem correspondência, fica o português. O seletor no canto troca na
hora, sem recarregar — recarregar derrubaria o stream e, no meio de uma pergunta,
custaria a resposta do participante ou o relógio no projetor. A escolha fica em
`localStorage` e vale por dispositivo: o apresentador pode estar em português com
a plateia em espanhol.

**O conteúdo do quiz não é traduzido** — enunciados, alternativas e justificativas
saem do JSON de quem monta a sala e aparecem como foram escritos.

Tudo vive em `public/i18n.js`: um dicionário por idioma e as funções `t()` e
`erro()`. As mensagens de erro do servidor viajam com um **código estável**
(`{ ok: false, error: 'senha incorreta', code: 'senha_incorreta' }`) e o cliente
traduz pelo código, caindo na frase em português se algum código escapar.
`npm test` falha se um código ficar sem tradução, se as três tabelas divergirem
em chaves, ou se um `{placeholder}` sumir numa das traduções.

Para acrescentar um idioma: uma tabela nova em `DICT` e o código em
`SUPORTADOS`, no topo do arquivo.

## Controles do apresentador

| tecla | ação |
| --- | --- |
| `Space` / `→` / `Enter` | avançar um passo do fluxo |
| `←` | voltar (de `question` volta pra leitura; da leitura volta ao slide do bloco) |
| `R` | revelar agora (fecha as respostas) — só durante `question` |
| `L` | ranking |
| `F` | tela cheia |

O rótulo do botão principal mostra sempre qual é o próximo passo (*Começar →
Primeira pergunta do bloco → Mostrar alternativas ⏱ → Encerrar e revelar →
Ranking do bloco → …*).

**Voltar** e **Lobby** aparecem só quando há uma pergunta em jogo (slide do bloco,
leitura, alternativas, reveal) — no lobby e nas telas de ranking eles saem da
barra, e o atalho `←` também fica inerte.

Não existe botão *Revelar*: durante as alternativas o próprio botão principal é
**Encerrar e revelar**. O atalho `R` continua valendo como caminho curto, e só
funciona nessa fase.

**Zerar ranking** zera a pontuação de todos **e remove quem está desconectado**
naquele momento — o confirm avisa quantos e quais, e um aviso confirma depois.
Serve para limpar a sala entre uma turma e outra sem reiniciar o servidor.

## Sem questions.json? A tela pede o arquivo

O servidor **não quebra** se não houver questionário: ele sobe numa sala vazia e a
tela do apresentador vira um pedido — *"Nenhum questionário carregado"* com os
botões **Carregar JSON…** e **Baixar modelo**, além de aceitar o arquivo
arrastado. O botão **Começar** fica desabilitado e `Space` não faz nada até haver
perguntas; quem entrar pelo celular antes disso vê "o apresentador ainda está
carregando as perguntas".

Vale também para um `questions.json` **inválido**: em vez de derrubar o processo,
a tela mostra o mesmo pedido com a lista de motivos por pergunta (e o console
imprime os mesmos motivos no boot). Depois do upload, tudo segue normalmente.

Com `QUESTIONS=…` apontando para um arquivo ilegível o upload continua desligado
(a variável manda) — a tela explica isso e pede para corrigir o caminho.

## Salas, senha e expiração

Cada JSON enviado em `/host` vira uma sala nova, com **código de 6 caracteres** e
senha escolhida por quem cria.

- **O código não é credencial.** Ele aparece no projetor e no QR, e existe para a
  plateia entrar. Quem protege a apresentação é a senha: todas as rotas de
  controle (avançar, revelar, zerar, remover participante) e o próprio stream do
  apresentador exigem autenticação.
- **A senha nunca é guardada** — nem no servidor, nem no navegador. O servidor
  guarda sal e hash (scrypt); o navegador guarda um token de sessão. Recarregar a
  página no mesmo aparelho não pede senha de novo; noutro aparelho, pede.
- **Senha perdida não tem recuperação.** Sem ela e sem o navegador que criou a
  sala, o caminho é criar outra.
- **A sala é apagada 24 h depois da última atividade** — qualquer interação
  reinicia o relógio, então uma apresentação em curso não morre no meio.
- A senha precisa de **pelo menos 5 caracteres** (`MIN_PASSWORD` em `server.js`).

Tetos, porque criar sala é anônimo: 20 salas no servidor, 2 por IP, uma criação
por IP por minuto, 100 perguntas por quiz, 100 participantes por sala, 512 KB de
JSON. Estourar o teto de salas responde `503` — a sala mais antiga **não** é
despejada, senão bastaria criar salas para derrubar um workshop alheio.

## Trocar o questionário de uma sala

No lobby da tela do apresentador tem um painel com o questionário atual
(quantas perguntas, quantos blocos):

- **Carregar JSON…** ou **arraste um `.json` no painel** — valida, troca na hora e
  zera a pontuação **daquela sala**. Se a sala não estiver limpa (alguém já
  pontuou, ou há pergunta em jogo) ele pede confirmação dizendo o que será
  perdido. Se o arquivo tiver problema, nada muda e a lista de erros aparece por
  pergunta (`pergunta 3: "answer" precisa ser o índice da correta…`).
- **Baixar modelo** — botão que baixa `modelo-perguntas.json`, um exemplo
  comentado com todos os campos (`GET /api/template`, serve o `template.json`).
- O questionário pertence à sala e vai para o disco junto com ela. Não existe
  arquivo global de upload: era justamente onde duas salas se atropelariam.
- Se o servidor foi iniciado com `QUESTIONS=…`, o upload é recusado (a variável
  manda) — troque o arquivo ou reinicie sem ela.

## Se o servidor cair, as salas voltam

A cada mudança de estado o servidor grava `rooms.json` (salas, participantes,
pontuação, respostas dadas, pergunta atual) — em rajadas agrupadas de 800 ms, e
também na hora ao receber `Ctrl-C`. Subindo de novo, ele **retoma sozinho**:

```
2 sala(s) retomada(s) do rooms.json:
  K7P2QM · Workshop 4 · 12 participante(s) · fase prompt
os participantes reconectam sozinhos · a senha continua a mesma
```

> **Em hospedagem gratuita isso não vale.** No plano free da Render (e
> semelhantes) o disco é efêmero e o serviço hiberna depois de ~15 min sem
> tráfego: o `rooms.json` não sobrevive a uma hibernação nem a um deploy. Lá o
> snapshot só cobre o restart dentro do mesmo container. A tela de criar sala
> avisa o apresentador disso em vez de prometer 24 h que o plano não entrega —
> para algo que precise durar, é plano pago com disco persistente.

Detalhes que importam:

- Uma pergunta que estava **aberta** volta como **leitura** da mesma pergunta — o
  relógio não pode ser retomado com sentido. Quem já respondeu continua com a
  resposta registrada e não responde de novo.
- Todos voltam como desconectados até o celular reabrir o stream (o `localStorage`
  faz isso sozinho ao recarregar).
- Uma sala é descartada no boot se já passou das **24 h** sem atividade, ou se o
  questionário dela não valida mais.
- O token do apresentador sobrevive ao restart, então quem estava controlando
  continua sem redigitar a senha.
- O formato antigo (`session.json`, de quando havia uma sala só) é ignorado de
  propósito: era uma sala sem senha, e inventar uma para ela seria pior que
  recomeçar.

## Entrar na sala e nomes repetidos

O mesmo nome pode existir em salas diferentes — a unicidade é por sala.

Dentro de uma sala o nome tem de ser único, **com uma exceção: se o pedido vem do mesmo IP
que criou aquele nome e aquele jogador está desconectado**, a pessoa recupera o
próprio jogador — com a pontuação intacta — em vez de tomar "nome já está na
sala". É o caso de quem trocou de aba, limpou o navegador, ficou sem bateria ou
caiu da rede: digita o mesmo nome e volta. O celular mostra "bem-vindo de volta,
X — N pontos recuperados".

Se aquele nome está **conectado neste momento**, a resposta é
*"esse nome está conectado agora — se for você, feche a outra aba"*. Isso fecha a
brecha de assumir o nome (e a pontuação) de alguém numa rede onde vários
aparelhos aparecem com o mesmo IP.

De outro IP, o nome continua bloqueado. A comparação ignora maiúsculas e espaços
sobrando (`  ana  ` = `Ana`), e a grafia original é preservada.

Responder também é amarrado ao aparelho: `POST /api/answer` só aceita se o IP da
requisição for o mesmo que entrou com aquele nome (*"entre de novo neste aparelho
para responder"*), e recusa respostas em menos de **300 ms** depois de as
alternativas aparecerem (*"calma — leia as alternativas primeiro"*), que nenhum
humano alcança e um script alcança sempre.

Isso reduz, mas não elimina, a trapaça: quem estiver **no mesmo IP** ainda pode
forjar. A vedação completa exige token por participante emitido no join
(não implementado).

O IP em si **não é guardado**: o que fica na sala e no disco é
`sha256(salDaSala + ip)`. As comparações acima só testam igualdade, então
funcionam igual — e como o sal é por sala, o mesmo endereço vira hashes
diferentes em salas diferentes, o que impede cruzar quem esteve em quais
apresentações.

## Fluxo

`lobby → [blockintro] → prompt → question → reveal → [scores] → … → end`

Se a próxima pergunta **abre um bloco que tem nome**, entra antes um slide só com
o nome do bloco (`bloco 2 de 5`, o título grande, quantas perguntas tem e se o
ranking vem no fim dele). Como `block` é opcional, perguntas sem bloco — ou com
`"block": ""` — vão direto para a leitura do enunciado, sem slide. `←` na leitura
volta para o slide do bloco quando aquela pergunta o abre.

O passo **`prompt`** existe para dar tempo de ler: o enunciado aparece sozinho na
tela grande, as alternativas ficam viradas (só as formas) e **o relógio não
corre** — fica parado indefinidamente. O celular mostra "olhe a tela grande" e
não aceita resposta (`respostas fechadas` se alguém tentar). O próximo comando
revela as alternativas e **é aí que os 30s começam**.

- O timer de cada pergunta vem de `seconds` no JSON; ao zerar, revela sozinho.
- **`seconds: 0` (ou negativo) = sem tempo limite**: não aparece relógio, nada
  revela sozinho e as respostas ficam abertas até o apresentador fechar com
  `Space`/`R`. A tela grande mostra o selo `∞ sem limite de tempo` e o celular
  avisa "sem tempo limite". Nesse caso o acerto vale **800 fixos** (sem prazo não
  há velocidade para premiar), mais o bônus de sequência normal.
- Pontos: 600–1000 por acerto (mais rápido, mais ponto) + 100 por acerto
  consecutivo, teto de 500 de bônus.
- Respostas erradas zeram o streak; quem não responde também.
- O contador mostra `respondidas / todos na sala`, com os desconectados listados à
  parte (`3 / 12 responderam · 2 desconectado(s)`) — o denominador é a sala
  inteira, senão ele passa de 100% quando alguém responde e depois cai.
- As bolinhas coloridas na barra mostram quem já respondeu; as contagens por
  alternativa só aparecem no reveal.

## Blocos e quando o ranking aparece

Perguntas **seguidas com o mesmo `block`** formam um bloco, ganham um slide de
abertura com o nome dele, e o ranking entra na virada de bloco — não depois de
cada pergunta. O `questions.json` do workshop tem
5 blocos (Abertura 3, Bloco 01 · 4, Bloco 02 · 6, Bloco 03 · 5, Fecho 2), então o
ranking aparece 4 vezes em vez de 19.

O rótulo do botão principal avisa o que vem: no fim de um bloco ele muda de
*Próxima pergunta* para *Ranking do bloco*. A tela do ranking vem intitulada
"Ranking — fim de Bloco 01 · Concorrência", e o celular mostra "fim de …".

Para mudar a política, no topo do JSON:

| `"ranking"` | efeito |
| --- | --- |
| `"block"` (padrão) | ao fim de cada bloco |
| `"always"` | depois de cada pergunta |
| `"end"` | só no fim de tudo |

E `"ranking": true` / `false` **dentro de uma pergunta** força ou suprime o
ranking depois dela, ignorando a política. Todas as perguntas com o mesmo `block`
(ou nenhuma com `block`) = um bloco só = ranking apenas no fim.

## O JSON de perguntas

`questions.json` foi gerado a partir de `questionario.md` (20 perguntas).

```json
{
  "title": "…", "subtitle": "…",
  "ranking": "block",           // opcional: block (padrão) | always | end
  "questions": [
    {
      "id": "Q1", "block": "Abertura", "cue": "depois do slide 3",
      "type": "choice",
      "text": "enunciado…",
      "options": ["A", "B", "C", "D"],
      "answer": 1,              // índice 0-based da correta
      "why": "explicação de 1 frase, aparece no reveal",
      "prediction": true,       // opcional: mostra o selo "APOSTE ANTES DA DEMO"
      "seconds": 25
    },
    { "id": "Q20", "type": "open", "text": "…", "placeholder": "…", "seconds": 90 }
  ]
}
```

O JSON é validado no carregamento e no upload: `questions` não pode estar vazia,
`text` é obrigatório, `choice` precisa de 2 a 4 opções com `answer` dentro da
faixa, e `id` não pode repetir. Campos desconhecidos são ignorados (o modelo usa
isso no `_leiame`).

- `type: "choice"` → 2 a 4 alternativas (A▲ B◆ C● D■).
- `type: "open"` → sem alternativas; o participante digita e as respostas viram
  cards na tela do apresentador (é a Q20, discussão aberta, não pontua).
- `block` é **opcional**: agrupa perguntas seguidas, gera o slide de abertura e
  define onde o ranking entra (ver acima). Sem `block`, nada disso aparece.
- `cue` é só documentação (o momento no roteiro), não afeta a execução.
- `seconds` é o tempo **depois** de as alternativas aparecerem — a leitura do
  enunciado não consome nada. Omitir o campo usa o padrão (30s, ou 90s em
  `open`); `0` ou negativo tira o limite de tempo.
- Para cortar uma pergunta, remova o objeto do array — ou pule com `←`/`→`.

## Animações

Regra: **cada animação toca uma vez, quando o elemento entra na tela, e não se
repete enquanto ele continuar lá.**

- As cartas de alternativa animam a entrada só na primeira aparição da pergunta.
  Ao virar de leitura para alternativas elas ficam paradas e só o texto surge
  (`.opts.settled`) — a mesma carta não sobe duas vezes na mesma pergunta.
- O enunciado e o selo de previsão não reanimam entre leitura → alternativas →
  reveal; só quando a pergunta muda (ou quando a página é recarregada no meio,
  que é uma aparição nova de verdade).
- O brilho que varre as cartas passa **uma vez** e se apaga (antes era `infinite`).
- Na pergunta aberta, cada resposta que chega **acrescenta só o card novo** — antes
  a tela era reconstruída a cada envio e tudo reanimava junto.
- No celular, tocar numa resposta não faz a grade reanimar: as não escolhidas
  apagam e a escolhida pulsa 3 vezes e para.
- **Fade-out**: toda troca de tela faz cross-fade. Uma cópia congelada da tela
  anterior (`.ghost`) desaparece por cima enquanto a nova entra, em vez do corte
  seco. Dura ~0,38s e o nó é removido em seguida.

Seguem em loop de propósito, porque são estado e não conteúdo: o fundo em
degradê e o número do relógio piscando nos últimos 5 segundos.

`prefers-reduced-motion: reduce` continua desligando tudo isso.

## Notas

- Transporte é **SSE** (`/events`) + `POST` JSON; reconecta sozinho e mostra
  faixa vermelha se o servidor cair.
- O estado vive em memória e é espelhado em `rooms.json` (ver acima).
- Cada sala guarda o próprio questionário, fase, participantes, relógio e
  conexões SSE. `broadcast` recebe a sala e itera só os clientes dela — não
  existe caminho de código capaz de mandar o estado de uma apresentação para os
  participantes de outra.
- O participante é lembrado por sala (`pollPid:CODIGO` no `localStorage`), então
  participar de duas salas no mesmo aparelho não mistura as identidades.
- O servidor não morre por exceção em requisição: o handler é embrulhado e devolve
  500, e `uncaughtException`/`unhandledRejection` são logados sem encerrar (salvando
  a sessão). Erro do próprio `listen` — porta ocupada, permissão — **encerra** com
  mensagem explicando, porque aí o servidor não existiria mesmo.
- Cada rodada de atualização calcula ranking e apuração **uma vez** e reaproveita
  para todos os clientes (antes era uma ordenação por conexão).
- O relógio do apresentador conta pelo horário **dele**: o servidor manda quanto
  falta, não um timestamp, então relógios dessincronizados não afetam nada.
- O participante é lembrado via `localStorage`, então recarregar a página no
  celular não perde a pontuação; e se o `localStorage` for embora, digitar o mesmo
  nome do mesmo aparelho recupera (ver acima).
- Um participante só conta como conectado enquanto o stream SSE dele está aberto —
  é isso que o "Zerar ranking" usa para decidir quem remover.
- `public/qr.js` é um encoder QR próprio (byte mode, ECC L, versões 1–10) —
  nada de CDN, funciona offline.
