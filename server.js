'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);

// Endereço público do site — o QR do lobby aponta para cá em vez do host local.
// Render entrega RENDER_EXTERNAL_URL sozinho; PUBLIC_URL manda por cima.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '')
  .trim().replace(/\/+$/, '');

// --------------------------------------------------------------------- tetos
// Criar sala é anônimo, então cada limite aqui é o que separa "workshop" de
// "alguém enche a memória num laço de for". Os números miram os 512 MB e a
// fração de CPU de uma instância pequena.
// Os que têm env são os que o roteiro de verificação precisa apertar ou afrouxar
// para caber num teste — não são botões de operação do dia a dia.
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 20);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 2);
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM || 100);
const MAX_QUIZ_BYTES = 512e3;   // ~1000 perguntas de texto realista
const MAX_QUESTIONS = 100;
const MAX_SSE_TOTAL = 400;      // o gargalo é CPU no push, não memória
const ROOM_CREATE_MS = Number(process.env.ROOM_CREATE_MS || 60e3); // uma sala por IP por minuto
const MIN_PASSWORD = 8;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_FILE = path.join(ROOT, 'questions.json');

// Questionário da sala criada no boot. As salas criadas por upload guardam o
// próprio questionário dentro de si — não existe mais arquivo global de upload,
// que era justamente onde duas salas se atropelavam.
function quizFile() {
  return process.env.QUESTIONS || DEFAULT_FILE;
}

// ---------------------------------------------------------------- quiz loading

class QuizError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

/** Valida e normaliza — devolve o quiz pronto ou lança QuizError com a lista de problemas. */
function prepareQuiz(raw) {
  const bad = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QuizError(['o JSON precisa ser um objeto']);
  if (!Array.isArray(raw.questions)) throw new QuizError(['falta a lista "questions"']);
  if (!raw.questions.length) throw new QuizError(['"questions" está vazia']);

  const seen = new Set();
  const questions = raw.questions.map((src, i) => {
    const q = Object.assign({}, src);
    const at = `pergunta ${i + 1}`;

    q.id = String(q.id || 'Q' + (i + 1));
    if (seen.has(q.id)) bad.push(`${at}: id "${q.id}" repetido`);
    seen.add(q.id);

    q.type = q.type === 'open' ? 'open' : 'choice';
    q.block = q.block === undefined || q.block === null ? '' : String(q.block);
    q.text = typeof q.text === 'string' ? q.text.trim() : '';
    if (!q.text) bad.push(`${at}: "text" faltando ou vazio`);

    if (q.type === 'choice') {
      if (!Array.isArray(q.options)) {
        bad.push(`${at}: "options" precisa ser uma lista (ou use "type":"open")`);
        q.options = [];
      } else {
        q.options = q.options.map((o) => String(o));
        if (q.options.length < 2 || q.options.length > 4)
          bad.push(`${at}: precisa de 2 a 4 opções (tem ${q.options.length})`);
      }
      const a = Number(q.answer);
      if (!Number.isInteger(a) || a < 0 || a >= q.options.length)
        bad.push(`${at}: "answer" precisa ser o índice da correta, de 0 a ${Math.max(0, q.options.length - 1)}`);
      else q.answer = a;
    } else {
      q.options = [];
      delete q.answer;
    }

    // ausente = padrão; <= 0 = sem tempo limite (o apresentador fecha na mão)
    q.seconds = q.seconds === undefined || q.seconds === null
      ? (q.type === 'open' ? 90 : 30)
      : Number(q.seconds);
    if (!Number.isFinite(q.seconds)) q.seconds = 0;
    q.untimed = q.seconds <= 0;

    q.why = typeof q.why === 'string' ? q.why : '';
    q.prediction = !!q.prediction;
    return q;
  });

  if (bad.length) throw new QuizError(bad.slice(0, 12));

  // --- blocos: perguntas consecutivas com o mesmo "block" formam um bloco,
  // e o ranking entra na virada de bloco. "ranking" no topo muda a política e
  // "ranking" na pergunta é a palavra final para aquela pergunta.
  const mode = ['always', 'block', 'end'].includes(raw.ranking) ? raw.ranking : 'block';
  questions.forEach((q, i) => {
    const last = i === questions.length - 1;
    const boundary = last || questions[i + 1].block !== q.block;
    q.rankingAfter = q.ranking === undefined || q.ranking === null
      ? (mode === 'always' ? true : mode === 'end' ? last : boundary)
      : !!q.ranking;
  });

  const blocks = [];
  questions.forEach((q, i) => {
    const cur = blocks[blocks.length - 1];
    if (cur && cur.title === q.block) { cur.count++; cur.to = i; }
    else blocks.push({ title: q.block, count: 1, from: i, to: i, index: blocks.length });
    q.blockIndex = blocks.length - 1;
    q.blockPos = blocks[blocks.length - 1].count;
  });

  return {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Live Poll',
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : '',
    ranking: mode,
    questions,
    blocks,
  };
}

// sala sem perguntas: o apresentador só vê o pedido para carregar o JSON
function emptyQuiz(problems) {
  return {
    title: 'Live Poll', subtitle: '', ranking: 'block',
    questions: [], blocks: [], source: null,
    missing: true, problems: problems || [],
  };
}

// nunca lança: arquivo ausente ou inválido vira o estado "sem questionário",
// com o motivo aparecendo na tela do apresentador em vez de derrubar o servidor
function loadQuiz() {
  const file = quizFile();
  if (!fs.existsSync(file)) return emptyQuiz();
  try {
    const q = prepareQuiz(JSON.parse(fs.readFileSync(file, 'utf8')));
    q.source = path.basename(file);
    q.missing = false;
    q.problems = [];
    return q;
  } catch (e) {
    const problems = e instanceof QuizError ? e.problems : [String(e.message || e)];
    console.log(`  !! ${path.basename(file)} não pôde ser lido: ${problems.join('; ')}`);
    return emptyQuiz(problems);
  }
}

// ----------------------------------------------------------------------- sala

// PROMPT = enunciado na tela, sem opções e sem relógio: o apresentador lê em voz
// alta e só então libera as alternativas, que é quando o tempo começa a contar.
const PHASE = {
  LOBBY: 'lobby',
  BLOCK: 'blockintro', // slide com o nome do bloco, só se a pergunta abre um bloco nomeado
  PROMPT: 'prompt',
  QUESTION: 'question',
  REVEAL: 'reveal',
  SCORES: 'scores',
  END: 'end',
};

const COLORS = ['#ff4d6d', '#4dabff', '#ffc93c', '#3ddc97', '#b47cff', '#ff8f4d', '#2ee6d6', '#f45bd6'];

function makeCode(n = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

// Uma sala carrega tudo que antes era global: o questionário, a fase, os
// participantes e o relógio da pergunta. Nenhuma função de jogo lê estado de
// fora daqui — é isso que mantém duas apresentações simultâneas isoladas.
function makeRoom(quiz, code = makeCode(5)) {
  return {
    code,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    quiz,
    quizRaw: null,   // JSON cru do upload: é o que vai para o disco
    ownerIp: null,   // só para o teto de salas por IP
    // A senha nunca é guardada — só o sal e o hash. Os tokens são o que o
    // navegador do apresentador carrega, para a senha não ficar em localStorage.
    passSalt: null,
    passHash: null,
    /** @type {Map<string, {createdAt:number,lastSeenAt:number}>} */
    tokens: new Map(),
    // O IP do participante não é gravado em claro. O sal é por sala, então o
    // mesmo endereço vira hashes diferentes em salas diferentes: quem olhar o
    // arquivo não consegue cruzar quem esteve em quais apresentações.
    ipSalt: crypto.randomBytes(16),
    phase: PHASE.LOBBY,
    index: -1,
    /** @type {Map<string, {id:string,name:string,score:number,streak:number,best:number,answers:Map<string,object>,online:boolean,color:string}>} */
    players: new Map(),
    questionStartedAt: 0,
    lockedAt: 0,
    timer: null,
    // conexões SSE DESTA sala. Ficam aqui, e não num Map global com um campo
    // "sala", porque assim não existe caminho de código capaz de mandar o
    // estado de uma apresentação para os participantes de outra.
    /** @type {Map<number, {res: http.ServerResponse, role: string, playerId: string|null, ping: NodeJS.Timeout}>} */
    clients: new Map(),
    // memo de um push: ranking e apuração são iguais para todos os clientes da
    // sala, então saem calculados uma vez por rodada e não uma vez por conexão
    memo: null,
  };
}

/** @type {Map<string, ReturnType<typeof makeRoom>>} */
const rooms = new Map();

// -------------------------------------------------------------------- senha
// O código da sala não é credencial: ele vai no projetor e no QR, e 32^5 é
// varrível em horas. Quem protege a apresentação é a senha.

// O IP serve só para três comparações de igualdade (recuperar nome, amarrar a
// resposta ao aparelho); nenhuma delas precisa do endereço em si.
function hashIp(room, ip) {
  if (!ip) return '';
  return crypto.createHash('sha256').update(room.ipSalt).update(String(ip)).digest('hex').slice(0, 32);
}

const SCRYPT_KEYLEN = 64;

// scrypt é memory-hard e vem no core. A versão assíncrona é obrigatória no
// caminho quente: a síncrona custa ~70-100 ms e este servidor é single-thread,
// então um login travaria o relógio de todas as outras salas.
function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Só no boot, quando ninguém está sendo atendido ainda.
function setPasswordSync(room, password) {
  room.passSalt = crypto.randomBytes(16);
  room.passHash = crypto.scryptSync(password, room.passSalt, SCRYPT_KEYLEN);
}

async function setPassword(room, password) {
  const salt = crypto.randomBytes(16);
  room.passHash = await derive(password, salt);
  room.passSalt = salt;
}

async function checkPassword(room, password) {
  if (!room.passHash || typeof password !== 'string' || !password) return false;
  try {
    // timingSafeEqual lança se os tamanhos diferirem; aqui ambos vêm de
    // keylen 64, mas o try/catch fecha a porta de qualquer forma
    return crypto.timingSafeEqual(await derive(password, room.passSalt), room.passHash);
  } catch {
    return false;
  }
}

function issueToken(room) {
  const token = crypto.randomBytes(32).toString('base64url');
  room.tokens.set(token, { createdAt: Date.now(), lastSeenAt: Date.now() });
  return token;
}

// O token é opaco e de 256 bits: lookup direto no Map basta, não há segredo a
// comparar caractere a caractere. Vários tokens vivos por sala é intencional —
// o notebook do projetor e o celular do apresentador controlam ao mesmo tempo.
function isHost(room, token) {
  const rec = token && room.tokens.get(token);
  if (!rec) return false;
  rec.lastSeenAt = Date.now();
  return true;
}

// EventSource não manda headers, então no SSE o token vem na query. É token de
// sessão, não a senha — e por isso o log de erro não pode imprimir a URL.
function hostToken(req, url) {
  return req.headers['x-host-token'] || url.searchParams.get('t') || '';
}

// ------------------------------------------------------------- criação de sala

/** @type {Map<string, number>} último instante em que cada IP criou uma sala */
const ultimaCriacao = new Map();

function contaSalasDoIp(ip) {
  let n = 0;
  for (const r of rooms.values()) if (r.ownerIp === ip) n++;
  return n;
}

function codigoLivre() {
  // 6 chars sobre alfabeto de 32 = 32^6 ≈ 1,07 bilhão. Um a mais que os 5 de
  // antes multiplica por 32 o custo de varrer códigos, e cabe no projetor.
  for (let i = 0; i < 50; i++) {
    const code = makeCode(6);
    if (!rooms.has(code)) return code;
  }
  return null;
}

async function createRoom(raw, password, ip) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    return { status: 400, body: { ok: false, error: `a senha precisa de pelo menos ${MIN_PASSWORD} caracteres` } };

  if (Array.isArray(raw && raw.questions) && raw.questions.length > MAX_QUESTIONS)
    return { status: 400, body: { ok: false, error: `no máximo ${MAX_QUESTIONS} perguntas por sala` } };

  let prepared;
  try {
    prepared = prepareQuiz(raw);
  } catch (e) {
    if (e instanceof QuizError) return { status: 400, body: { ok: false, error: 'JSON inválido', problems: e.problems } };
    return { status: 400, body: { ok: false, error: String(e.message || e) } };
  }

  const agora = Date.now();
  const ultima = ultimaCriacao.get(ip) || 0;
  if (agora - ultima < ROOM_CREATE_MS) {
    const faltam = Math.ceil((ROOM_CREATE_MS - (agora - ultima)) / 1000);
    return { status: 429, body: { ok: false, error: `espere ${faltam}s para criar outra sala` } };
  }
  if (contaSalasDoIp(ip) >= MAX_ROOMS_PER_IP)
    return { status: 429, body: { ok: false, error: `você já tem ${MAX_ROOMS_PER_IP} salas abertas` } };

  // varre as expiradas antes de dizer não — pode haver vaga livre
  sweepRooms();
  if (rooms.size >= MAX_ROOMS)
    return { status: 503, body: { ok: false, error: 'limite de salas atingido, tente em alguns minutos' } };

  const code = codigoLivre();
  if (!code) return { status: 503, body: { ok: false, error: 'não consegui gerar um código livre' } };

  const room = makeRoom(prepared, code);
  room.quiz.source = 'upload';
  room.quiz.missing = false;
  room.quiz.problems = [];
  room.quizRaw = raw;
  room.ownerIp = ip;
  await setPassword(room, password);
  rooms.set(code, room);
  ultimaCriacao.set(ip, agora);

  console.log(`  sala criada: ${code} · ${room.quiz.title} · ${room.quiz.questions.length} perguntas`);
  return { status: 200, body: { ok: true, room: code, token: issueToken(room), title: room.quiz.title, count: room.quiz.questions.length } };
}

function totalSse() {
  let n = 0;
  for (const r of rooms.values()) n += r.clients.size;
  return n;
}

// ------------------------------------------------------------------ expiração

const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 24 * 60 * 60 * 1000);

// Derrubar uma sala é fechar quatro coisas, e três delas seguram referência ao
// room inteiro. O ping é a mais fácil de esquecer: sem o clearInterval ele
// segue escrevendo num socket morto a cada 15 s, para sempre.
function destroyRoom(room, motivo) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  for (const entry of room.clients.values()) {
    clearInterval(entry.ping);
    try { sseSend(entry, 'gone', { room: room.code, motivo }); entry.res.end(); } catch { /* já foi */ }
  }
  room.clients.clear();
  room.players.clear();
  room.tokens.clear();
  room.memo = null;
  rooms.delete(room.code);
  scheduleRoomsSave(); // sai da memória e do disco junto
  console.log(`  sala encerrada: ${room.code} (${motivo})`);
}

function sweepRooms() {
  const agora = Date.now();
  for (const room of [...rooms.values()]) {
    if (agora - room.lastActivityAt > ROOM_TTL_MS) destroyRoom(room, 'sem atividade há 24h');
  }
}

// Ainda uma sala só, criada no boot a partir do questions.json. A criação por
// upload entra no passo seguinte e é quando o nome gritado desaparece.
const THE_ROOM = makeRoom(loadQuiz(), process.env.ROOM || makeCode(5));
rooms.set(THE_ROOM.code, THE_ROOM);

// Senha do apresentador: da env, ou sorteada e impressa uma vez no console.
// Nunca é gravada em lugar nenhum — só o sal e o hash ficam na sala.
const BOOT_PASSWORD = process.env.HOST_PASSWORD || makeCode(10);

// --------------------------------------------------------- salas salvas em disco
// Fechar o terminal no meio do workshop não pode custar a pontuação da sala.
//
// Ressalva importante: em hospedagem gratuita (Render free e semelhantes) o
// disco é efêmero e o serviço hiberna depois de alguns minutos sem tráfego.
// Lá este arquivo NÃO sobrevive a uma hibernação nem a um deploy — ele cobre o
// restart dentro do mesmo container, que é a perda mais comum no dia a dia. A
// tela de criar sala diz isso ao apresentador em vez de prometer 24h que o
// plano não entrega.
const ROOMS_FILE = path.join(ROOT, 'rooms.json');
const SNAPSHOT_V = 2;

function roomSnapshot(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    quizRaw: room.quizRaw,
    passSalt: room.passSalt ? room.passSalt.toString('hex') : null,
    passHash: room.passHash ? room.passHash.toString('hex') : null,
    ipSalt: room.ipSalt.toString('hex'),
    ownerIpHash: room.ownerIp ? hashIp(room, room.ownerIp) : null,
    tokens: Object.fromEntries(room.tokens),
    index: room.index,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, ipHash: p.ipHash, color: p.color,
      score: p.score, streak: p.streak, best: p.best,
      // Map dentro de Map: o de dentro vira objeto e volta em new Map()
      answers: Object.fromEntries(p.answers),
    })),
  };
}

function roomsSnapshot() {
  return {
    v: SNAPSHOT_V,
    savedAt: new Date().toISOString(),
    // só salas com questionário próprio: a do boot renasce do questions.json
    rooms: [...rooms.values()].filter((r) => r.quizRaw).map(roomSnapshot),
  };
}

// Um timer para o processo inteiro, não um por sala: N salas ativas fariam N
// writes concorrentes do mesmo arquivo, se atropelando.
let saveTimer = null;

function scheduleRoomsSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(ROOMS_FILE, JSON.stringify(roomsSnapshot()), 'utf8', (err) => {
      if (err) console.log(`  !! não consegui salvar rooms.json: ${err.message}`);
    });
  }, 800);
}

function saveRoomsNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomsSnapshot()), 'utf8');
  } catch (e) {
    console.log(`  !! não consegui salvar rooms.json: ${e.message}`);
  }
}

// devolve quantas salas voltaram
function restoreRooms() {
  let snap;
  try {
    if (!fs.existsSync(ROOMS_FILE)) return 0;
    snap = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  } catch (e) {
    console.log(`  !! rooms.json ilegível, ignorando: ${e.message}`);
    return 0;
  }
  // formato antigo (session.json de sala única) não é convertido: tinha uma
  // sala sem senha, e adivinhar uma para ela seria pior que recomeçar
  if (!snap || snap.v !== SNAPSHOT_V || !Array.isArray(snap.rooms)) return 0;

  const agora = Date.now();
  let n = 0;
  for (const s of snap.rooms) {
    if (!CODE_RE.test(String(s.code || ''))) continue;
    if (!(agora - (s.lastActivityAt || 0) < ROOM_TTL_MS)) continue; // já expirou parada
    let prepared;
    try {
      prepared = prepareQuiz(s.quizRaw);
    } catch {
      continue; // questionário que não valida mais não vira sala
    }
    const room = makeRoom(prepared, s.code);
    room.quiz.source = 'upload';
    room.quiz.missing = false;
    room.quiz.problems = [];
    room.quizRaw = s.quizRaw;
    room.createdAt = s.createdAt || agora;
    room.lastActivityAt = s.lastActivityAt || agora;
    if (s.passSalt && s.passHash) {
      room.passSalt = Buffer.from(s.passSalt, 'hex');
      room.passHash = Buffer.from(s.passHash, 'hex');
    }
    if (s.ipSalt) room.ipSalt = Buffer.from(s.ipSalt, 'hex');
    for (const [t, rec] of Object.entries(s.tokens || {})) room.tokens.set(t, rec);

    for (const p of s.players || []) {
      room.players.set(p.id, {
        id: p.id, name: p.name, ipHash: p.ipHash || '', color: p.color,
        score: p.score || 0, streak: p.streak || 0, best: p.best || 0,
        answers: new Map(Object.entries(p.answers || {})),
        online: false, // só a conexão SSE afirma presença
      });
    }
    room.index = Number.isInteger(s.index) ? s.index : -1;
    // uma pergunta que estava aberta não pode ter o relógio retomado: volta para
    // a leitura da mesma pergunta, e quem já respondeu mantém a resposta dada
    room.phase = s.phase === PHASE.QUESTION ? PHASE.PROMPT : (s.phase || PHASE.LOBBY);
    if (room.index < 0 || room.index >= room.quiz.questions.length) {
      room.index = -1;
      room.phase = PHASE.LOBBY;
    }
    rooms.set(room.code, room);
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ SSE hub

let sseId = 0;

function sseSend(entry, event, data) {
  try {
    entry.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client vanished; cleanup happens on 'close' */
  }
}

function broadcast(room, event, dataFor) {
  for (const entry of room.clients.values()) {
    const payload = typeof dataFor === 'function' ? dataFor(entry) : dataFor;
    if (payload !== null) sseSend(entry, event, payload);
  }
}

function pushState(room) {
  room.memo = {};
  try {
    const host = hostView(room); // idêntico para todos os apresentadores
    broadcast(room, 'state', (entry) => (entry.role === 'host' ? host : playerView(room, entry.playerId)));
  } finally {
    room.memo = null;
  }
  scheduleRoomsSave();
}

// --------------------------------------------------------------------- views

function currentQuestion(room) {
  return room.index >= 0 && room.index < room.quiz.questions.length ? room.quiz.questions[room.index] : null;
}

function publicQuestion(q) {
  if (!q) return null;
  return {
    id: q.id,
    block: q.block || '',
    type: q.type,
    text: q.text,
    options: q.options || [],
    prediction: !!q.prediction,
    placeholder: q.placeholder || 'Sua resposta…',
    seconds: q.seconds,
    untimed: !!q.untimed,
  };
}

function tally(room) {
  if (room.memo && room.memo.tally) return room.memo.tally;
  const t = computeTally(room);
  if (room.memo) room.memo.tally = t;
  return t;
}

function computeTally(room) {
  const q = currentQuestion(room);
  if (!q) return { counts: [], total: 0, texts: [] };
  const counts = new Array((q.options || []).length).fill(0);
  const texts = [];
  let total = 0;
  for (const p of room.players.values()) {
    const a = p.answers.get(q.id);
    if (!a) continue;
    total++;
    if (q.type === 'open') texts.push({ name: p.name, color: p.color, text: a.text });
    else if (typeof a.choice === 'number' && counts[a.choice] !== undefined) counts[a.choice]++;
  }
  return { counts, total, texts };
}

function leaderboard(room, limit = 0) {
  let rows = room.memo && room.memo.board;
  if (!rows) {
    rows = [...room.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score, streak: p.streak, color: p.color }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    rows.forEach((r, i) => (r.rank = i + 1));
    if (room.memo) room.memo.board = rows;
  }
  return limit ? rows.slice(0, limit) : rows;
}

function timeLeft(room) {
  const q = currentQuestion(room);
  if (!q || room.phase !== PHASE.QUESTION) return 0;
  if (q.untimed) return null; // sem limite: nada a mostrar num relógio
  const elapsed = (Date.now() - room.questionStartedAt) / 1000;
  return Math.max(0, Math.round(q.seconds - elapsed));
}

function blockInfo(room, q) {
  const b = room.quiz.blocks[q.blockIndex];
  if (!b) return null;
  return {
    title: b.title, pos: q.blockPos, size: b.count,
    index: b.index, total: room.quiz.blocks.length,
    last: q.blockPos === b.count, rankingAfter: !!q.rankingAfter,
  };
}

// A URL que o participante abre. Sem PUBLIC_URL não dá para inventar o host —
// a tela do apresentador mostra o código para digitar e o QR sai de cena.
function joinUrlFor(room) {
  return PUBLIC_URL ? `${PUBLIC_URL}/play?r=${room.code}` : '';
}

function hostView(room) {
  const q = currentQuestion(room);
  const t = tally(room);
  return {
    role: 'host',
    room: room.code,
    phase: room.phase,
    index: room.index,
    total: room.quiz.questions.length,
    title: room.quiz.title,
    subtitle: room.quiz.subtitle || '',
    joinUrl: joinUrlFor(room),
    question: publicQuestion(q),
    reveal: room.phase === PHASE.REVEAL || room.phase === PHASE.END
      ? { answer: q ? q.answer : null, why: q ? q.why : '' }
      : null,
    tally: t,
    answered: t.total,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, online: p.online,
      score: p.score,
      answered: q ? p.answers.has(q.id) : false,
    })),
    block: q ? blockInfo(room, q) : null,
    quizInfo: {
      source: room.quiz.source, count: room.quiz.questions.length, ranking: room.quiz.ranking,
      blocks: room.quiz.blocks.map((b) => ({ title: b.title, count: b.count })),
      missing: !!room.quiz.missing,          // nada carregado: a tela pede o upload
      problems: room.quiz.problems || [],    // ou o arquivo existe mas está inválido
      locked: !!process.env.QUESTIONS,       // servidor amarrado a um arquivo por env
    },
    leaderboard: leaderboard(room),
    timeLeft: timeLeft(room),
  };
}

function playerView(room, playerId) {
  const p = playerId ? room.players.get(playerId) : null;
  const q = currentQuestion(room);
  const myAnswer = p && q ? p.answers.get(q.id) || null : null;
  const board = leaderboard(room);
  const me = p ? board.find((r) => r.id === p.id) : null;
  return {
    role: 'player',
    room: room.code,
    phase: room.phase,
    index: room.index,
    total: room.quiz.questions.length,
    title: room.quiz.title,
    joined: !!p,
    me: p
      ? { id: p.id, name: p.name, color: p.color, score: p.score, streak: p.streak, rank: me ? me.rank : null, of: board.length }
      : null,
    question: q
      ? {
          id: q.id, type: q.type, optionCount: (q.options || []).length,
          seconds: q.seconds, untimed: !!q.untimed, prediction: !!q.prediction,
          placeholder: q.placeholder || 'Sua resposta…',
        }
      : null,
    myAnswer,
    reveal:
      room.phase === PHASE.REVEAL && q
        ? {
            answer: q.answer !== undefined ? q.answer : null,
            correct: myAnswer ? !!myAnswer.correct : null,
            gained: myAnswer ? myAnswer.gained || 0 : 0,
            open: q.type === 'open',
            untimed: !!q.untimed,
          }
        : null,
    block: q ? blockInfo(room, q) : null,
    podium: room.phase === PHASE.END || room.phase === PHASE.SCORES ? board.slice(0, 5) : null,
    playerCount: room.players.size,
    timeLeft: timeLeft(room),
  };
}

// ------------------------------------------------------------------- scoring

function scoreFor(q, elapsedMs) {
  if (q.untimed) return 800; // sem prazo não há como premiar velocidade — todos igual
  const ratio = Math.min(1, elapsedMs / (q.seconds * 1000));
  return Math.round(600 + 400 * (1 - ratio)); // 1000 instant → 600 at the buzzer
}

function lockQuestion(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.lockedAt = Date.now();
}

function goto(room, phase) {
  room.phase = phase;
  pushState(room);
}

// abre uma pergunta: pelo slide do bloco, se ela começa um bloco nomeado
function enter(room, index) {
  if (index < 0 || index >= room.quiz.questions.length) return;
  const q = room.quiz.questions[index];
  return q.blockPos === 1 && q.block ? showBlockIntro(room, index) : showPrompt(room, index);
}

function showBlockIntro(room, index) {
  if (index < 0 || index >= room.quiz.questions.length) return;
  lockQuestion(room);
  room.index = index;
  room.questionStartedAt = 0;
  goto(room, PHASE.BLOCK);
}

// enunciado sozinho na tela — sem opções, sem relógio
function showPrompt(room, index) {
  if (index < 0 || index >= room.quiz.questions.length) return;
  lockQuestion(room);
  room.index = index;
  room.questionStartedAt = 0;
  goto(room, PHASE.PROMPT);
}

// libera as alternativas e aí sim começa a contagem
function startQuestion(room, index) {
  if (index === undefined) index = room.index;
  if (index < 0 || index >= room.quiz.questions.length) return;
  lockQuestion(room);
  room.index = index;
  room.questionStartedAt = Date.now();
  room.phase = PHASE.QUESTION;
  const q = room.quiz.questions[index];
  if (!q.untimed) {
    room.timer = setTimeout(() => {
      if (room.phase === PHASE.QUESTION) reveal(room);
    }, q.seconds * 1000 + 400);
  }
  // sem timestamp absoluto: o relógio do apresentador pode estar dessincronizado
  // do relógio do servidor, então mandamos quanto falta e ele conta com o dele
  broadcast(room, 'countdown', { seconds: q.seconds, untimed: !!q.untimed, secondsLeft: q.seconds });
  pushState(room);
}

function reveal(room) {
  lockQuestion(room);
  const q = currentQuestion(room);
  if (!q) return;
  if (q.type !== 'open') {
    // settle streaks for players who never answered
    for (const p of room.players.values()) {
      if (!p.answers.has(q.id)) p.streak = 0;
    }
  }
  goto(room, PHASE.REVEAL);
}

// lobby → [slide do bloco] → enunciado → opções+relógio → reveal → [ranking] → …
function next(room) {
  if (!room.quiz.questions.length) return; // sem questionário não há para onde avançar
  if (room.phase === PHASE.BLOCK) return showPrompt(room, room.index);
  if (room.phase === PHASE.PROMPT) return startQuestion(room, room.index);
  if (room.phase === PHASE.QUESTION) return reveal(room);
  if (room.phase === PHASE.REVEAL) {
    if (room.index + 1 >= room.quiz.questions.length) return goto(room, PHASE.END);
    // ranking só na virada de bloco (ou onde o JSON pedir)
    const q = currentQuestion(room);
    return q && q.rankingAfter ? goto(room, PHASE.SCORES) : enter(room, room.index + 1);
  }
  if (room.phase === PHASE.END) return;
  if (room.index + 1 >= room.quiz.questions.length) return goto(room, PHASE.END);
  return enter(room, room.index + 1);
}

function prev(room) {
  if (room.phase === PHASE.QUESTION) return showPrompt(room, room.index);
  const q = currentQuestion(room);
  // do ranking volta para o reveal da pergunta que acabou de sair — é ela a tela
  // anterior. Sem isto o "Voltar" pularia para o enunciado da pergunta de antes
  if ((room.phase === PHASE.SCORES || room.phase === PHASE.END) && q)
    return goto(room, PHASE.REVEAL);
  // do enunciado volta para o slide do bloco, quando essa pergunta o abre
  if (room.phase === PHASE.PROMPT && q && q.blockPos === 1 && q.block)
    return showBlockIntro(room, room.index);
  if (room.index <= 0) { room.index = -1; return goto(room, PHASE.LOBBY); }
  showPrompt(room, room.index - 1);
}

// zera o ranking: quem está conectado volta a zero, quem já saiu é removido
// (senão a lista da sala vira um cemitério de quem passou pela sessão anterior)
function resetGame(room, hard) {
  lockQuestion(room);
  room.index = -1;
  room.phase = PHASE.LOBBY;
  const removed = [];
  if (hard) {
    removed.push(...[...room.players.values()].map((p) => p.name));
    room.players.clear();
    // o snapshot acompanha: a sala esvaziada nao volta cheia no proximo boot
    scheduleRoomsSave();
  } else {
    for (const p of [...room.players.values()]) {
      if (!p.online) { removed.push(p.name); room.players.delete(p.id); continue; }
      p.score = 0; p.streak = 0; p.best = 0; p.answers.clear();
    }
  }
  // NÃO recarrega o questionário: ele pertence à sala. Recarregar de disco era
  // o certo quando existia uma sala só e um arquivo só; numa sala criada por
  // upload isso trocaria o questionário dela pelo questions.json do projeto.
  pushState(room);
  return { ok: true, removed, kept: room.players.size };
}

// ---------------------------------------------------------- troca do questionário

// Troca o questionário DESTA sala. Não toca em arquivo nenhum: o questionário
// vive na sala e vai para o disco junto com ela, no rooms.json. Um arquivo
// global de upload voltaria a ser o ponto onde duas salas se atropelam.
function installQuiz(room, raw) {
  if (process.env.QUESTIONS)
    return { ok: false, error: 'o servidor foi iniciado com QUESTIONS=… — troque pelo arquivo ou reinicie sem a variável' };
  if (Array.isArray(raw && raw.questions) && raw.questions.length > MAX_QUESTIONS)
    return { ok: false, error: `no máximo ${MAX_QUESTIONS} perguntas por sala` };
  let prepared;
  try {
    prepared = prepareQuiz(raw);
  } catch (e) {
    if (e instanceof QuizError) return { ok: false, error: 'JSON inválido', problems: e.problems };
    return { ok: false, error: String(e.message || e) };
  }
  room.quiz = prepared;
  room.quiz.source = 'upload';
  room.quiz.missing = false;
  room.quiz.problems = [];
  room.quizRaw = raw;
  resetGame(room, false);
  console.log(`  questionário trocado na sala ${room.code}: ${room.quiz.title} · ${room.quiz.questions.length} perguntas`);
  return { ok: true, title: room.quiz.title, count: room.quiz.questions.length, blocks: room.quiz.blocks.length };
}

// ------------------------------------------------------------------ handlers

const MIN_ANSWER_MS = 300; // nenhum humano toca antes disso; script toca em 5ms

function submitAnswer(room, playerId, body, ip) {
  const p = room.players.get(playerId);
  const q = currentQuestion(room);
  if (!p || !q) return { ok: false, error: 'sem pergunta ativa' };
  if (room.phase !== PHASE.QUESTION) return { ok: false, error: 'respostas fechadas' };
  if (p.answers.has(q.id)) return { ok: false, error: 'você já respondeu' };
  // a resposta tem de vir do aparelho que entrou com esse nome
  const ipHash = hashIp(room, ip);
  if (ipHash && p.ipHash && ipHash !== p.ipHash)
    return { ok: false, error: 'entre de novo neste aparelho para responder' };

  const elapsed = Date.now() - room.questionStartedAt;
  if (!q.untimed && elapsed > q.seconds * 1000 + 1500)
    return { ok: false, error: 'tempo esgotado' };
  if (elapsed < MIN_ANSWER_MS) return { ok: false, error: 'calma — leia as alternativas primeiro' };

  if (q.type === 'open') {
    const text = String(body.text || '').trim().slice(0, 200);
    if (!text) return { ok: false, error: 'resposta vazia' };
    p.answers.set(q.id, { text, at: elapsed });
  } else {
    const choice = Number(body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length)
      return { ok: false, error: 'opção inválida' };
    const correct = choice === q.answer;
    let gained = 0;
    if (correct) {
      gained = scoreFor(q, elapsed) + Math.min(500, p.streak * 100);
      p.streak += 1;
      p.best = Math.max(p.best, p.streak);
    } else {
      p.streak = 0;
    }
    p.score += gained;
    p.answers.set(q.id, { choice, correct, gained, at: elapsed });
  }

  pushState(room);
  const everyone = [...room.players.values()].filter((x) => x.online);
  if (everyone.length && everyone.every((x) => x.answers.has(q.id))) {
    broadcast(room, 'allin', { id: q.id });
  }
  return { ok: true };
}

function join(room, name, ip) {
  // corpo hostil não pode virar exceção: {"name":{"toString":1}} quebrava o String()
  name = (typeof name === 'string' ? name : '').trim().replace(/\s+/g, ' ').slice(0, 18);
  if (!name) return { ok: false, error: 'digite um nome' };

  // nome repetido só passa se vier do mesmo IP que o criou — aí é a mesma pessoa
  // voltando (trocou de aba, limpou o navegador, caiu a rede) e recupera a pontuação
  const ipHash = hashIp(room, ip);
  const taken = [...room.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!taken && room.players.size >= MAX_PLAYERS_PER_ROOM)
    return { ok: false, error: 'a sala está lotada' };
  if (taken) {
    if (taken.ipHash !== ipHash) return { ok: false, error: 'esse nome já está na sala' };
    // mesmo IP não basta: se aquele jogador está conectado agora, ninguém assume
    // o lugar dele (numa rede com NAT o IP não identifica a pessoa)
    if (taken.online)
      return { ok: false, error: 'esse nome está conectado agora — se for você, feche a outra aba' };
    // não marca online aqui: quem afirma presença é o stream SSE que vem a seguir
    pushState(room);
    return {
      ok: true, id: taken.id, name: taken.name, color: taken.color,
      reclaimed: true, score: taken.score,
    };
  }

  const id = crypto.randomUUID();
  const color = COLORS[room.players.size % COLORS.length];
  // online é afirmado pela conexão SSE, não pelo join: um join que nunca abriu
  // o stream (fechou o celular na hora) fica removível pelo "Zerar ranking"
  room.players.set(id, { id, name, ipHash, score: 0, streak: 0, best: 0, answers: new Map(), online: false, color });
  broadcast(room, 'joined', { name, color, count: room.players.size });
  pushState(room);
  return { ok: true, id, name, color };
}

// --------------------------------------------------------------- http server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ::ffff:192.168.0.9 e ::1 são o mesmo host que 192.168.0.9 e 127.0.0.1
function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  const ip = raw.replace(/^::ffff:/, '');
  return ip === '::1' ? '127.0.0.1' : ip;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1e5) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve({ __tooBig: true });
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({ __badJson: true }); }
    });
    req.on('error', () => resolve({ __tooBig: tooBig, __badJson: !tooBig }));
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'presenter.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  // uma requisição estranha não pode levar o processo embora no meio do workshop
  handle(req, res).catch((e) => {
    // só o caminho, nunca a query: o token do apresentador viaja em ?t= no SSE
    const alvo = String(req.url || '').split('?')[0];
    console.log(`  !! erro em ${req.method} ${alvo}: ${e && e.stack ? e.stack : e}`);
    try {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'erro interno' });
      else res.end();
    } catch { /* conexão já foi */ }
  });
});

// O código chega do cliente por três caminhos — header no controle do host,
// query no SSE e no QR, corpo no join/answer do participante. A validação vem
// antes de qualquer uso porque o código também vira nome de arquivo lá na
// persistência, e aí um "../.." seria path traversal.
const CODE_RE = /^[A-Z2-9]{5,8}$/;

function resolveRoom(req, url, body) {
  const raw = req.headers['x-room'] || url.searchParams.get('room') || (body && body.room) || '';
  const code = String(raw).toUpperCase();
  if (code) {
    if (!CODE_RE.test(code)) return null;
    return tocar(rooms.get(code));
  }
  // Sem código: só resolve quando não há ambiguidade possível. Cobre o QR já
  // impresso e as abas abertas de antes desta mudança.
  if (rooms.size === 1) return tocar(rooms.values().next().value);
  return null;
}

// O sweeper roda a cada 5 min, então uma sala pode passar do prazo antes de ele
// acordar. Conferir aqui evita que ela siga atendendo nesse intervalo.
function tocar(room) {
  if (!room) return null;
  if (Date.now() - room.lastActivityAt > ROOM_TTL_MS) {
    destroyRoom(room, 'sem atividade há 24h');
    return null;
  }
  room.lastActivityAt = Date.now(); // o TTL conta da última atividade
  return room;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/events') {
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const playerId = url.searchParams.get('pid');
    const room = resolveRoom(req, url, null);
    // 404 antes dos headers de event-stream: assim o cliente distingue "sala
    // encerrada" de "rede caiu" e para de reconectar a cada 1,5 s
    if (!room) return sendJson(res, 404, { ok: false, error: 'sala não existe ou expirou' });
    // o stream do apresentador entrega o enunciado e as alternativas, que o
    // produto esconde de proposito do celular do participante — proteger só os
    // POSTs deixaria a porta da frente aberta
    if (role === 'host' && !isHost(room, hostToken(req, url)))
      return sendJson(res, 401, { ok: false, error: 'senha necessária' });
    // acima deste teto a degradação seria silenciosa e todo mundo travaria
    // junto; melhor recusar a conexão nova e manter as antigas fluindo
    if (totalSse() >= MAX_SSE_TOTAL)
      return sendJson(res, 503, { ok: false, error: 'servidor cheio, tente em instantes' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const id = ++sseId;
    // o ping vive na entry, não numa variável local: derrubar a sala precisa
    // conseguir pará-lo, senão ele segue escrevendo num socket morto a cada 15 s
    // e mantém viva a closure que referencia a resposta
    const entry = {
      res, role,
      playerId: room.players.has(playerId) ? playerId : null,
      ping: setInterval(() => res.write(': ping\n\n'), 15000),
    };
    room.clients.set(id, entry);
    if (entry.playerId) room.players.get(entry.playerId).online = true;
    sseSend(entry, 'state', role === 'host' ? hostView(room) : playerView(room, entry.playerId));
    req.on('close', () => {
      clearInterval(entry.ping);
      // destroyRoom fecha as respostas, e isso dispara este handler; sem a
      // guarda, um push seria montado para uma sala que já não existe
      if (!rooms.has(room.code)) return;
      room.clients.delete(id);
      if (entry.playerId) {
        const still = [...room.clients.values()].some((c) => c.playerId === entry.playerId);
        const pl = room.players.get(entry.playerId);
        if (pl && !still) { pl.online = false; pushState(room); }
      }
    });
    return;
  }

  if (p === '/api/room') {
    const room = resolveRoom(req, url, null);
    if (!room) return sendJson(res, 404, { ok: false, error: 'sala não existe ou expirou' });
    return sendJson(res, 200, { ok: true, room: room.code, title: room.quiz.title, phase: room.phase });
  }

  // modelo de questionário para baixar e editar
  if (p === '/api/template') {
    return fs.readFile(path.join(ROOT, 'template.json'), (err, buf) => {
      if (err) return sendJson(res, 500, { ok: false, error: 'template.json não encontrado' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="modelo-perguntas.json"',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  }

  if (req.method === 'POST') {
    // o upload do questionário é o único corpo grande que aceitamos
    const grande = p === '/api/host/quiz' || p === '/api/rooms';
    const body = await readBody(req, grande ? MAX_QUIZ_BYTES : 1e5);
    if (body.__tooBig) return sendJson(res, 413, { ok: false, error: `arquivo grande demais (máx ${Math.round(MAX_QUIZ_BYTES / 1000)} KB)` });
    if (body.__badJson) return sendJson(res, 400, { ok: false, error: 'não consegui ler o JSON — confira vírgulas e chaves' });

    // criar sala é a única rota que não pertence a nenhuma sala ainda
    if (p === '/api/rooms') {
      const r = await createRoom(body.quiz, body.password, clientIp(req));
      return sendJson(res, r.status, r.body);
    }
    // a sala é resolvida DEPOIS do await: entre ler o corpo e despachar, ela
    // pode ter sido derrubada pela expiração
    const room = resolveRoom(req, url, body);
    if (!room) return sendJson(res, 404, { ok: false, error: 'sala não existe ou expirou' });

    // trocar a senha por um token é a única rota /api/host/* que dispensa token
    if (p === '/api/host/login') {
      const ok = await checkPassword(room, body.password);
      if (!ok) return sendJson(res, 401, { ok: false, error: 'senha incorreta' });
      return sendJson(res, 200, { ok: true, room: room.code, token: issueToken(room) });
    }

    // todo o controle da apresentação exige token — inclusive kick e reset,
    // que são destrutivos e hoje não pediam nada
    if (p.startsWith('/api/host/') && !isHost(room, hostToken(req, url)))
      return sendJson(res, 401, { ok: false, error: 'senha necessária' });

    switch (p) {
      case '/api/host/logout':
        room.tokens.delete(hostToken(req, url));
        return sendJson(res, 200, { ok: true });
      case '/api/host/quiz': {
        const r = installQuiz(room, body.quiz);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      case '/api/join': return sendJson(res, 200, join(room, body.name, clientIp(req)));
      case '/api/answer': return sendJson(res, 200, submitAnswer(room, body.id, body, clientIp(req)));
      case '/api/host/next': next(room); return sendJson(res, 200, { ok: true });
      case '/api/host/prev': prev(room); return sendJson(res, 200, { ok: true });
      case '/api/host/start': // vai para o enunciado (sem relógio)
        showPrompt(room, Number.isInteger(body.index) ? body.index : 0);
        return sendJson(res, 200, { ok: true });
      case '/api/host/options': // libera as alternativas e inicia a contagem
        startQuestion(room, Number.isInteger(body.index) ? body.index : room.index);
        return sendJson(res, 200, { ok: true });
      case '/api/host/reveal': reveal(room); return sendJson(res, 200, { ok: true });
      case '/api/host/lock':
        if (room.phase === PHASE.QUESTION) { lockQuestion(room); goto(room, PHASE.QUESTION); }
        return sendJson(res, 200, { ok: true });
      case '/api/host/scores': lockQuestion(room); goto(room, PHASE.SCORES); return sendJson(res, 200, { ok: true });
      case '/api/host/lobby': lockQuestion(room); room.index = -1; goto(room, PHASE.LOBBY); return sendJson(res, 200, { ok: true });
      case '/api/host/reset': return sendJson(res, 200, resetGame(room, !!body.hard));
      case '/api/host/kick':
        room.players.delete(body.playerId);
        pushState(room);
        return sendJson(res, 200, { ok: true });
      default: return sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  // Serve a dynamically generated QR SVG that points to the public join URL
  if (p === '/qr.svg') {
    const room = resolveRoom(req, url, null);
    const join = room && joinUrlFor(room);
    // sem endereço público não existe QR honesto: melhor um erro do que um
    // código que leva a lugar nenhum — ou, pior, ao servidor de outra pessoa
    if (!join) return sendJson(res, 404, { ok: false, error: 'sem sala ou sem PUBLIC_URL para gerar o QR' });
    try {
      const QR = require(path.join(ROOT, 'public', 'qr.js'));
      const svg = QR.svg(join, { dark: '#14082b', light: '#ffffff', quiet: 4 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(svg);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('error generating QR');
    }
    return;
  }

  if (p === '/play' || p === '/play/') return serveStatic(res, '/play.html');
  if (p === '/host' || p === '/host/') return serveStatic(res, '/presenter.html');
  return serveStatic(res, p);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// Guardas globais: melhor um log feio do que a sala perdida. Um erro do próprio
// listen (porta ocupada, permissão) é a exceção — aí sair é o certo, porque o
// servidor não existiria de verdade.
let listening = false;
const FATAL = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

function guard(kind) {
  return (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!listening || FATAL.has(e.code)) {
      console.log('');
      console.log(e.code === 'EADDRINUSE'
        ? `  !! a porta ${PORT} já está em uso. Feche o outro servidor ou use PORT=3001 node server.js`
        : `  !! não foi possível iniciar: ${e.message}`);
      process.exit(1);
    }
    console.log(`  !! ${kind} ignorado para manter a sala no ar: ${e.stack || e.message}`);
    saveRoomsNow();
  };
}
process.on('uncaughtException', guard('erro'));
process.on('unhandledRejection', guard('rejeição'));

// Tick de 5 min: a precisão exigida é de horas. unref() para não ser este
// intervalo o motivo de o processo nunca terminar.
setInterval(sweepRooms, 5 * 60 * 1000).unref();

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    saveRoomsNow();
    console.log('\n  sessão salva em session.json — subindo de novo, a sala volta como estava.');
    process.exit(0);
  });
}

server.listen(PORT, () => {
  listening = true;
  const ips = lanAddresses();
  // no boot ninguém está sendo atendido ainda: a versão síncrona não atrapalha
  setPasswordSync(THE_ROOM, BOOT_PASSWORD);
  const retomadas = restoreRooms();
  const quiz = THE_ROOM.quiz;
  console.log('');
  console.log(`  ${quiz.title}`);
  if (quiz.missing) {
    console.log(`  sala: ${THE_ROOM.code}   ·   SEM QUESTIONÁRIO`);
    console.log('');
    if (process.env.QUESTIONS) {
      console.log(`  QUESTIONS aponta para ${process.env.QUESTIONS}, que não pôde ser lido.`);
      console.log('  Corrija o caminho e reinicie — nesse modo o upload fica desligado.');
    } else {
      console.log(quiz.problems.length
        ? '  O questions.json existe mas não passou na validação (motivos acima).'
        : '  Nenhum questions.json encontrado.');
      console.log('  Abra a tela do apresentador, baixe o modelo e carregue seu JSON por lá.');
    }
  } else {
    console.log(`  sala: ${THE_ROOM.code}   ·   ${quiz.questions.length} perguntas   ·   ${quiz.blocks.length} bloco(s)   ·   ${quiz.source}`);
  }
  if (retomadas) {
    console.log('');
    console.log(`  ${retomadas} sala(s) retomada(s) do rooms.json:`);
    for (const r of rooms.values()) {
      if (r === THE_ROOM) continue;
      console.log(`    ${r.code} · ${r.quiz.title} · ${r.players.size} participante(s) · fase ${r.phase}`);
    }
    console.log('  os participantes reconectam sozinhos · a senha continua a mesma');
  }
  console.log('');
  if (process.env.HOST_PASSWORD) {
    console.log('  senha do apresentador: a que você definiu em HOST_PASSWORD');
  } else {
    console.log(`  senha do apresentador: ${BOOT_PASSWORD}   <-- anote, só aparece aqui`);
  }
  console.log('');
  console.log(`  controlar a sala do boot : http://localhost:${PORT}/host?r=${THE_ROOM.code}`);
  console.log(`  criar outra sala         : http://localhost:${PORT}/host`);
  console.log(`  participante             : http://localhost:${PORT}/play?r=${THE_ROOM.code}`);
  for (const ip of ips) console.log(`                             http://${ip}:${PORT}/play?r=${THE_ROOM.code}`);
  console.log('');
});
