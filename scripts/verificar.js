'use strict';
// Roteiro de verificação do servidor. Sem framework, sem dependências:
//
//   node scripts/verificar.js
//
// Cada suíte sobe o próprio servidor numa porta e num diretório temporário
// isolado, porque várias delas dependem de começar sem sala nenhuma e sem
// rooms.json — rodar todas contra um servidor só faria uma poluir a outra.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let porta = 4900 + Math.floor(Math.random() * 90);

// ------------------------------------------------------------------ utilitários

function req(P, method, caminho, corpo, headers) {
  return new Promise((resolve, reject) => {
    const body = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const r = http.request({ host: '127.0.0.1', port: P, path: caminho, method,
      headers: Object.assign(
        body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
        headers || {}) },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* nem tudo é JSON */ } resolve({ status: res.statusCode, body: j, raw: d }); });
      });
    r.on('error', reject);
    r.end(body);
  });
}

// Espião de SSE: guarda todos os frames crus, para dar para auditar depois o que
// cada sala recebeu — é assim que se prova que nada vazou de uma para outra.
function espiar(P, query) {
  const rec = { frames: [], raw: '', state: null, status: 0, req: null };
  rec.req = http.get({ host: '127.0.0.1', port: P, path: '/events?' + query }, (res) => {
    rec.status = res.statusCode;
    if (res.statusCode !== 200) { res.resume(); return; }
    let buf = '';
    res.on('data', (c) => {
      buf += c; rec.raw += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (frame.split('\n').find((l) => l.startsWith('event:')) || '').slice(6).trim();
        const dl = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!ev || !dl) continue;
        rec.frames.push({ ev, data: dl.slice(5).trim() });
        if (ev === 'state') { try { rec.state = JSON.parse(dl.slice(5).trim()); } catch { /* frame partido */ } }
      }
    });
  });
  rec.req.on('error', () => {});
  return rec;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let falhas = 0;
const falhou = [];

function ok(rotulo, cond, detalhe) {
  total++;
  if (cond) { console.log(`    ok    ${rotulo}`); return; }
  falhas++;
  falhou.push(rotulo);
  console.log(`    FALHA ${rotulo}\n            ${detalhe}`);
}

// sobe um servidor isolado e devolve {porta, parar()}
async function subir(env) {
  const P = ++porta;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funquiz-'));
  for (const f of ['server.js', 'questions.json', 'template.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: Object.assign({}, process.env, { PORT: String(P) }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (c) => (log += c));
  proc.stderr.on('data', (c) => (log += c));

  for (let i = 0; i < 60; i++) {
    await espera(100);
    try { await req(P, 'GET', '/api/room'); break; } catch { /* ainda subindo */ }
  }
  return {
    porta: P, dir,
    log: () => log,
    parar: () => new Promise((r) => { proc.on('exit', () => r()); proc.kill(); setTimeout(r, 1500); }),
    limpar: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* já foi */ } },
  };
}

const QUIZ = (titulo, resposta) => ({
  title: titulo,
  questions: [
    { id: 'X1', text: `pergunta secreta de ${titulo}`, options: ['alfa', 'beta', 'gama'], answer: resposta, why: `porque sim, ${titulo}`, seconds: 30 },
    { id: 'X2', text: `segunda de ${titulo}`, options: ['um', 'dois'], answer: 0, seconds: 30 },
  ],
});

// ------------------------------------------------------------------- as suítes

// O fluxo de sempre, do join ao reset: é o que garante que o suporte a várias
// salas não custou nada ao comportamento de uma.
async function regressao() {
  const s = await subir({ HOST_PASSWORD: 'senha-de-teste-1' });
  const P = s.porta;
  try {
    const login = await req(P, 'POST', '/api/host/login', { password: 'senha-de-teste-1' });
    const T = login.body.token;
    const h = { 'X-Host-Token': T };
    const host = espiar(P, 'role=host&t=' + encodeURIComponent(T));
    await espera(400);
    ok('host recebe estado ao conectar', !!host.state, 'nenhum state chegou');
    ok('questionário do questions.json carregado', host.state.total > 0, `total=${host.state.total}`);

    const a = await req(P, 'POST', '/api/join', { name: 'Ana' });
    const b = await req(P, 'POST', '/api/join', { name: 'Bruno' });
    ok('participantes entram', a.body.ok && b.body.ok, JSON.stringify([a.body, b.body]));

    const volta = await req(P, 'POST', '/api/join', { name: 'ana' });
    ok('nome repetido offline recupera a pontuação', volta.body.ok && volta.body.reclaimed && volta.body.id === a.body.id, JSON.stringify(volta.body));

    const ana = espiar(P, 'role=player&pid=' + a.body.id);
    await espera(300);
    ok('nome repetido de quem está online é recusado', !(await req(P, 'POST', '/api/join', { name: 'ana' })).body.ok, 'aceitou duplicata');
    ok('participante não recebe o texto das alternativas',
      !ana.state.question || ana.state.question.options === undefined, 'alternativas vazaram para o celular');

    await req(P, 'POST', '/api/host/start', { index: 0 }, h);
    await espera(200);
    ok('fase prompt', host.state.phase === 'prompt', `phase=${host.state.phase}`);
    ok('gabarito escondido antes do reveal', host.state.reveal === null, JSON.stringify(host.state.reveal));

    await req(P, 'POST', '/api/host/options', { index: 0 }, h);
    await espera(200);
    ok('fase question com countdown', host.state.phase === 'question' && host.frames.some((f) => f.ev === 'countdown'), `phase=${host.state.phase}`);

    await espera(400); // MIN_ANSWER_MS
    const ra = await req(P, 'POST', '/api/answer', { id: a.body.id, choice: 0 });
    await req(P, 'POST', '/api/answer', { id: b.body.id, choice: 1 });
    ok('resposta aceita', ra.body.ok, JSON.stringify(ra.body));
    ok('resposta dupla recusada', !(await req(P, 'POST', '/api/answer', { id: a.body.id, choice: 2 })).body.ok, 'aceitou duas');
    await espera(200);
    ok('apuração contou as duas', host.state.tally.total === 2, `total=${host.state.tally.total}`);

    await req(P, 'POST', '/api/host/reveal', {}, h);
    await espera(200);
    ok('reveal traz o gabarito', host.state.phase === 'reveal' && host.state.reveal.answer !== null, JSON.stringify(host.state.reveal));
    ok('alguém pontuou', host.state.leaderboard.some((r) => r.score > 0), JSON.stringify(host.state.leaderboard));

    await req(P, 'POST', '/api/host/lobby', {}, h);
    await espera(150);
    ok('volta ao lobby preservando o placar',
      host.state.phase === 'lobby' && host.state.leaderboard.some((r) => r.score > 0), `phase=${host.state.phase}`);

    await req(P, 'POST', '/api/host/reset', { hard: false }, h);
    await espera(200);
    ok('reset zera o placar', host.state.leaderboard.every((r) => r.score === 0), JSON.stringify(host.state.leaderboard));
  } finally { await s.parar(); s.limpar(); }
}

// O código da sala vem de três lugares e é validado antes de qualquer uso —
// ele também vira nome de arquivo na persistência.
async function roteamento() {
  const s = await subir({ HOST_PASSWORD: 'senha-de-teste-1', PUBLIC_URL: `http://localhost:${porta + 1}` });
  const P = s.porta;
  try {
    const info = await req(P, 'GET', '/api/room');
    ok('sala única resolve sem código (compatibilidade)', info.status === 200 && info.body.room, JSON.stringify(info.body));
    const CODE = info.body.room;
    const T = (await req(P, 'POST', '/api/host/login', { room: CODE, password: 'senha-de-teste-1' })).body.token;

    const bom = espiar(P, `room=${CODE}&role=host&t=${encodeURIComponent(T)}`);
    await espera(300);
    ok('SSE com código certo conecta', bom.status === 200 && bom.state.room === CODE, `status=${bom.status}`);
    ok('join aceita a sala pelo corpo', (await req(P, 'POST', '/api/join', { name: 'Duda', room: CODE })).body.ok, 'recusou');
    ok('controle aceita a sala pelo header', (await req(P, 'POST', '/api/host/lobby', {}, { 'X-Room': CODE, 'X-Host-Token': T })).status === 200, 'recusou');

    const outro = CODE === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
    ok('SSE em sala inexistente dá 404', espiar(P, `room=${outro}&role=host&t=${T}`) && (await espera(300), true) && true, '');
    const semSala = espiar(P, `room=${outro}&role=host&t=${encodeURIComponent(T)}`);
    await espera(300);
    ok('SSE em sala inexistente responde 404', semSala.status === 404, `status=${semSala.status}`);
    ok('join em sala inexistente dá 404', (await req(P, 'POST', '/api/join', { name: 'Ze', room: outro })).status === 404, 'passou');
    ok('controle em sala inexistente dá 404', (await req(P, 'POST', '/api/host/next', {}, { 'X-Room': outro, 'X-Host-Token': T })).status === 404, 'passou');

    // T9: o código chega do cliente e vira caminho de arquivo
    for (const mau of ['../../etc', '..%2F..%2Fserver.js', 'abc!@#', 'AB', 'AAAAAAAAAAAAAAAA']) {
      ok(`código malformado recusado: ${mau}`, (await req(P, 'POST', '/api/join', { name: 'x', room: mau })).status === 404, 'passou');
    }
    ok('server.js intacto depois das tentativas', fs.existsSync(path.join(s.dir, 'server.js')), 'sumiu');

    const qr = await req(P, 'GET', '/qr.svg?room=' + CODE);
    ok('QR responde SVG', qr.status === 200 && qr.raw.startsWith('<svg'), `status=${qr.status}`);
    ok('QR de sala inexistente dá 404', (await req(P, 'GET', '/qr.svg?room=' + outro)).status === 404, 'gerou QR de sala que não existe');
  } finally { await s.parar(); s.limpar(); }
}

// Sem senha não se controla nada — nem pelos POSTs, nem pelo stream do host.
async function autenticacao() {
  const s = await subir({ HOST_PASSWORD: 'senha-de-teste-1' });
  const P = s.porta;
  try {
    const CODE = (await req(P, 'GET', '/api/room')).body.room;
    const rotas = ['/api/host/next', '/api/host/prev', '/api/host/start', '/api/host/options',
      '/api/host/reveal', '/api/host/lock', '/api/host/scores', '/api/host/lobby',
      '/api/host/reset', '/api/host/kick', '/api/host/quiz', '/api/host/quiz/default'];
    for (const rota of rotas) {
      ok(`sem token: ${rota} dá 401`, (await req(P, 'POST', rota, {}, { 'X-Room': CODE })).status === 401, 'passou sem senha');
    }

    const semToken = espiar(P, `room=${CODE}&role=host`);
    await espera(300);
    ok('stream do host sem token dá 401', semToken.status === 401, `status=${semToken.status}`);
    const jogador = espiar(P, `room=${CODE}&role=player`);
    await espera(300);
    ok('stream do participante segue aberto', jogador.status === 200, `status=${jogador.status}`);

    ok('senha errada dá 401', (await req(P, 'POST', '/api/host/login', { room: CODE, password: 'chute' })).status === 401, 'entrou');
    ok('senha ausente dá 401', (await req(P, 'POST', '/api/host/login', { room: CODE })).status === 401, 'entrou');

    const login = await req(P, 'POST', '/api/host/login', { room: CODE, password: 'senha-de-teste-1' });
    ok('senha certa devolve token', login.status === 200 && login.body.token.length >= 40, JSON.stringify(login.body));
    const T = login.body.token;
    ok('com token o controle libera', (await req(P, 'POST', '/api/host/lobby', {}, { 'X-Room': CODE, 'X-Host-Token': T })).status === 200, 'recusou');
    ok('token inventado dá 401', (await req(P, 'POST', '/api/host/next', {}, { 'X-Room': CODE, 'X-Host-Token': 'x'.repeat(43) })).status === 401, 'passou');

    await req(P, 'POST', '/api/host/logout', {}, { 'X-Room': CODE, 'X-Host-Token': T });
    ok('token não vale depois do logout', (await req(P, 'POST', '/api/host/next', {}, { 'X-Room': CODE, 'X-Host-Token': T })).status === 401, 'ainda valia');

    ok('senha não aparece no log', !s.log().includes('senha-de-teste-1') || !!process.env.HOST_PASSWORD_ESPERADO, 'senha no console');
  } finally { await s.parar(); s.limpar(); }
}

// O teste que justifica o refactor inteiro.
async function multisala() {
  const s = await subir({ ROOM_CREATE_MS: '0', MAX_ROOMS_PER_IP: '50' });
  const P = s.porta;
  try {
    const A = await req(P, 'POST', '/api/rooms', { quiz: QUIZ('SALA-ALFA', 0), password: 'senha-alfa-1' });
    const B = await req(P, 'POST', '/api/rooms', { quiz: QUIZ('SALA-BETA', 2), password: 'senha-beta-1' });
    ok('duas salas criadas', A.body.ok && B.body.ok, JSON.stringify([A.body, B.body]));
    ok('códigos diferentes, de 6 caracteres', A.body.room !== B.body.room && A.body.room.length === 6, `${A.body.room}/${B.body.room}`);
    const [ca, cb, ta, tb] = [A.body.room, B.body.room, A.body.token, B.body.token];

    const hostA = espiar(P, `room=${ca}&role=host&t=${encodeURIComponent(ta)}`);
    const hostB = espiar(P, `room=${cb}&role=host&t=${encodeURIComponent(tb)}`);
    await espera(400);
    ok('cada host vê o próprio questionário',
      hostA.state.title === 'SALA-ALFA' && hostB.state.title === 'SALA-BETA', `${hostA.state.title}/${hostB.state.title}`);

    const pa = await req(P, 'POST', '/api/join', { name: 'Alice', room: ca });
    const pb = await req(P, 'POST', '/api/join', { name: 'Bob', room: cb });
    ok('o mesmo nome pode existir nas duas salas', (await req(P, 'POST', '/api/join', { name: 'Alice', room: cb })).body.ok, 'recusou');

    const jogadorB = espiar(P, `room=${cb}&role=player&pid=${pb.body.id}`);
    await espera(300);
    const framesAntes = jogadorB.frames.length;

    // T1 — mexer numa sala não pode mover a outra
    await req(P, 'POST', '/api/host/start', { index: 0 }, { 'X-Room': ca, 'X-Host-Token': ta });
    await req(P, 'POST', '/api/host/options', { index: 0 }, { 'X-Room': ca, 'X-Host-Token': ta });
    await espera(600);
    ok('T1 · A avançou', hostA.state.phase === 'question', `phase=${hostA.state.phase}`);
    ok('T1 · B seguiu parada no lobby', hostB.state.phase === 'lobby', `phase=${hostB.state.phase}`);
    ok('T1 · participante de B não recebeu nenhum frame', jogadorB.frames.length === framesAntes,
      `${jogadorB.frames.length - framesAntes} frame(s) a mais`);

    // T2 — o conteúdo de uma sala não pode aparecer na outra
    await espera(400);
    await req(P, 'POST', '/api/answer', { id: pa.body.id, choice: 0, room: ca });
    await req(P, 'POST', '/api/host/reveal', {}, { 'X-Room': ca, 'X-Host-Token': ta });
    await espera(500);
    ok('T2 · A revelou', hostA.state.phase === 'reveal' && !!hostA.state.reveal, JSON.stringify(hostA.state.reveal));
    ok('T2 · o título de A nunca aparece no stream de B', !jogadorB.raw.includes('SALA-ALFA'), 'vazou');
    ok('T2 · o enunciado de A nunca aparece em B', !jogadorB.raw.includes('pergunta secreta de SALA-ALFA'), 'vazou');
    ok('T2 · a justificativa de A nunca aparece em B', !jogadorB.raw.includes('porque sim, SALA-ALFA'), 'vazou');
    ok('T2 · nem o host de B viu algo de A', !hostB.raw.includes('SALA-ALFA'), 'vazou');

    // T3 — token de uma sala não vale na outra
    ok('T3 · token de A na sala B dá 401', (await req(P, 'POST', '/api/host/next', {}, { 'X-Room': cb, 'X-Host-Token': ta })).status === 401, 'passou');
    ok('T3 · token de B na sala A dá 401', (await req(P, 'POST', '/api/host/next', {}, { 'X-Room': ca, 'X-Host-Token': tb })).status === 401, 'passou');
    ok('T3 · token próprio continua valendo', (await req(P, 'POST', '/api/host/lobby', {}, { 'X-Room': ca, 'X-Host-Token': ta })).status === 200, 'recusou');
    const cruzado = espiar(P, `room=${cb}&role=host&t=${encodeURIComponent(ta)}`);
    await espera(300);
    ok('T3 · stream de host com token da outra sala dá 401', cruzado.status === 401, `status=${cruzado.status}`);
    ok('T3 · a senha de A não abre B', (await req(P, 'POST', '/api/host/login', { room: cb, password: 'senha-alfa-1' })).status === 401, 'abriu');

    // "Zerar ranking" não pode trocar o questionário: quando existia uma sala só,
    // o reset recarregava o quiz do disco, e numa sala criada por upload isso
    // substituiria o questionário dela pelo questions.json do projeto.
    await req(P, 'POST', '/api/host/reset', { hard: false }, { 'X-Room': ca, 'X-Host-Token': ta });
    await espera(300);
    ok('reset preserva o questionário da sala', hostA.state.title === 'SALA-ALFA', `virou ${hostA.state.title}`);
    ok('reset zera o placar', hostA.state.leaderboard.every((r) => r.score === 0), JSON.stringify(hostA.state.leaderboard));

    // e o mesmo vale para trocar o questionário de uma sala: não afeta a outra
    await req(P, 'POST', '/api/host/quiz', { quiz: QUIZ('SALA-ALFA-V2', 1) }, { 'X-Room': ca, 'X-Host-Token': ta });
    await espera(300);
    ok('trocar o questionário afeta só a sala pedida', hostA.state.title === 'SALA-ALFA-V2' && hostB.state.title === 'SALA-BETA',
      `${hostA.state.title}/${hostB.state.title}`);

    // T5 — o que não pode virar sala
    ok('T5 · senha curta recusada', (await req(P, 'POST', '/api/rooms', { quiz: QUIZ('X', 0), password: 'curta' })).status === 400, 'aceitou');
    ok('T5 · quiz vazio recusado', (await req(P, 'POST', '/api/rooms', { quiz: { questions: [] }, password: 'senha-boa-123' })).status === 400, 'aceitou');
    const gigante = { title: 'g', questions: Array.from({ length: 200 }, (_, i) => ({ id: 'q' + i, text: 't', options: ['a', 'b'], answer: 0 })) };
    ok('T5 · perguntas demais recusadas', (await req(P, 'POST', '/api/rooms', { quiz: gigante, password: 'senha-boa-123' })).status === 400, 'aceitou');
  } finally { await s.parar(); s.limpar(); }
}

// T5 continuação: os tetos de criação, e a garantia de que a sala ativa não é
// despejada para dar lugar a uma nova.
async function tetos() {
  const s = await subir({ MAX_ROOMS: '3', ROOM_CREATE_MS: '0', MAX_ROOMS_PER_IP: '50' });
  const P = s.porta;
  try {
    const r1 = await req(P, 'POST', '/api/rooms', { quiz: QUIZ('R1', 0), password: 'senha-boa-11' });
    const r2 = await req(P, 'POST', '/api/rooms', { quiz: QUIZ('R2', 0), password: 'senha-boa-22' });
    ok('cria até o teto', r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
    const r3 = await req(P, 'POST', '/api/rooms', { quiz: QUIZ('R3', 0), password: 'senha-boa-33' });
    ok('estourar o teto dá 503', r3.status === 503, `status=${r3.status}`);
    ok('a primeira sala continua viva (sem evicção LRU)', (await req(P, 'GET', '/api/room?room=' + r1.body.room)).status === 200, 'foi despejada');
    ok('e continua controlável', (await req(P, 'POST', '/api/host/lobby', {}, { 'X-Room': r1.body.room, 'X-Host-Token': r1.body.token })).status === 200, 'perdeu o controle');
  } finally { await s.parar(); s.limpar(); }

  const s2 = await subir({});
  const P2 = s2.porta;
  try {
    const a = await req(P2, 'POST', '/api/rooms', { quiz: QUIZ('A', 0), password: 'senha-boa-11' });
    const b = await req(P2, 'POST', '/api/rooms', { quiz: QUIZ('B', 0), password: 'senha-boa-22' });
    ok('primeira sala do IP passa', a.status === 200, `status=${a.status}`);
    ok('segunda no mesmo minuto dá 429', b.status === 429, `status=${b.status}`);
    ok('e diz quanto esperar', /espere \d+s/.test((b.body && b.body.error) || ''), JSON.stringify(b.body));
  } finally { await s2.parar(); s2.limpar(); }
}

// T7 e T8: a sala sobrevive a um restart, expira sozinha, e o servidor não cai
// quando o snapshot desaparece — que é o que a hospedagem gratuita faz.
async function persistencia() {
  const s = await subir({ ROOM_CREATE_MS: '0' });
  const P = s.porta;
  const senha = 'senha-persistente-9';
  let antes;
  try {
    const c = await req(P, 'POST', '/api/rooms', { quiz: QUIZ('PERSISTE', 1), password: senha });
    const { room, token } = c.body;
    const h = { 'X-Room': room, 'X-Host-Token': token };
    const a = await req(P, 'POST', '/api/join', { name: 'Nina', room });
    await req(P, 'POST', '/api/join', { name: 'Omar', room });
    await req(P, 'POST', '/api/host/start', { index: 0 }, h);
    await req(P, 'POST', '/api/host/options', { index: 0 }, h);
    await espera(400);
    await req(P, 'POST', '/api/answer', { id: a.body.id, choice: 1, room }); // a certa
    await req(P, 'POST', '/api/host/reveal', {}, h);
    await espera(1200); // deixa o debounce de 800 ms gravar

    const espiao = espiar(P, `room=${room}&role=host&t=${encodeURIComponent(token)}`);
    await espera(300);
    antes = { room, token, placar: espiao.state.leaderboard.map((r) => ({ name: r.name, score: r.score })), phase: espiao.state.phase, index: espiao.state.index };
    ok('alguém pontuou antes do restart', antes.placar.some((r) => r.score > 0), JSON.stringify(antes.placar));

    const arquivo = fs.readFileSync(path.join(s.dir, 'rooms.json'), 'utf8');
    ok('a senha não vai para o disco', !arquivo.includes(senha), 'senha gravada em claro');
    ok('o IP não vai em claro para o disco', !/"ip":"|127\.0\.0\.1/.test(arquivo), 'IP gravado em claro');
    ok('o participante vai como hash', arquivo.includes('"ipHash"'), 'sem ipHash');
  } finally { await s.parar(); }

  // reinicia no MESMO diretório
  const s2 = await subir({ ROOM_CREATE_MS: '0' });
  // subir() usa um diretório novo, então trazemos o snapshot para ele
  await s2.parar();
  fs.copyFileSync(path.join(s.dir, 'rooms.json'), path.join(s2.dir, 'rooms.json'));
  const s3 = spawnEm(s2.dir, s2.porta);
  try {
    await esperarPorta(s2.porta);
    const P3 = s2.porta;
    const espiao = espiar(P3, `room=${antes.room}&role=host&t=${encodeURIComponent(antes.token)}`);
    await espera(400);
    ok('T8 · a sala voltou depois do restart', espiao.status === 200 && !!espiao.state, `status=${espiao.status}`);
    if (espiao.state) {
      ok('T8 · placar idêntico', JSON.stringify(espiao.state.leaderboard.map((r) => ({ name: r.name, score: r.score }))) === JSON.stringify(antes.placar), 'placar mudou');
      ok('T8 · fase e índice preservados', espiao.state.phase === antes.phase && espiao.state.index === antes.index, `${espiao.state.phase}/${espiao.state.index}`);
      ok('T8 · participantes voltam offline', espiao.state.players.every((p) => !p.online), 'alguém voltou online sem stream');
    }
    ok('T8 · o token de antes do restart ainda vale', (await req(P3, 'POST', '/api/host/lobby', {}, { 'X-Room': antes.room, 'X-Host-Token': antes.token })).status === 200, 'token perdido');
    ok('T8 · a senha continua a mesma', (await req(P3, 'POST', '/api/host/login', { room: antes.room, password: senha })).status === 200, 'senha mudou');
    ok('T8 · senha errada segue recusada', (await req(P3, 'POST', '/api/host/login', { room: antes.room, password: 'outra-coisa-1' })).status === 401, 'aceitou');
  } finally { s3.kill(); await espera(500); s.limpar(); s2.limpar(); }

  // T8b — snapshot sumiu (o que a hospedagem gratuita faz a cada deploy)
  const s4 = await subir({});
  try {
    ok('T8b · sala de antes some com 404, sem derrubar o servidor',
      (await req(s4.porta, 'GET', '/api/room?room=' + antes.room)).status === 404, 'sala fantasma');
    ok('T8b · servidor segue respondendo', (await req(s4.porta, 'GET', '/api/room')).status === 200, 'caiu');
  } finally { await s4.parar(); s4.limpar(); }

  // T7 — expiração
  const s5 = await subir({ ROOM_TTL_MS: '2000', ROOM_CREATE_MS: '0' });
  try {
    const c = await req(s5.porta, 'POST', '/api/rooms', { quiz: QUIZ('EFEMERA', 0), password: 'senha-boa-123' });
    ok('T7 · sala viva logo após criar', (await req(s5.porta, 'GET', '/api/room?room=' + c.body.room)).status === 200, 'nasceu morta');
    await espera(2600);
    ok('T7 · expira sem esperar o sweeper', (await req(s5.porta, 'GET', '/api/room?room=' + c.body.room)).status === 404, 'ainda atendia');
    ok('T7 · controle da sala expirada dá 404',
      (await req(s5.porta, 'POST', '/api/host/next', {}, { 'X-Room': c.body.room, 'X-Host-Token': c.body.token })).status === 404, 'ainda controlava');
    await espera(1200);
    const arquivo = JSON.parse(fs.readFileSync(path.join(s5.dir, 'rooms.json'), 'utf8'));
    ok('T7 · e some do disco também', !arquivo.rooms.some((r) => r.code === c.body.room), 'ficou no snapshot');
  } finally { await s5.parar(); s5.limpar(); }
}

function spawnEm(dir, P) {
  return spawn(process.execPath, ['server.js'], {
    cwd: dir, env: Object.assign({}, process.env, { PORT: String(P), ROOM_CREATE_MS: '0' }), stdio: 'ignore',
  });
}
async function esperarPorta(P) {
  for (let i = 0; i < 60; i++) {
    await espera(100);
    try { await req(P, 'GET', '/api/room'); return; } catch { /* ainda subindo */ }
  }
}

// ---------------------------------------------------------------------- runner

const SUITES = [
  ['regressão · o fluxo de sempre', regressao],
  ['roteamento · código da sala', roteamento],
  ['autenticação · senha do apresentador', autenticacao],
  ['multissala · isolamento', multisala],
  ['tetos · criação de salas', tetos],
  ['persistência · restart e expiração', persistencia],
];

(async () => {
  const inicio = Date.now();
  for (const [nome, fn] of SUITES) {
    console.log(`\n  ${nome}`);
    try {
      await fn();
    } catch (e) {
      falhas++;
      falhou.push(`${nome} (exceção)`);
      console.log(`    FALHA suíte quebrou: ${e && e.stack ? e.stack : e}`);
    }
  }
  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`\n  ${total - falhas}/${total} verificações passaram em ${seg}s`);
  if (falhas) {
    console.log('\n  falharam:');
    for (const f of falhou) console.log(`    · ${f}`);
    console.log('');
  } else {
    console.log('  tudo verde\n');
  }
  process.exit(falhas ? 1 : 0);
})();
