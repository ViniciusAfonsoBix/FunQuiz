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

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_FILE = path.join(ROOT, 'questions.json');
const UPLOAD_FILE = path.join(ROOT, 'uploaded-questions.json');

// QUESTIONS no ambiente manda; senão, um JSON enviado pela tela do apresentador
// tem precedência sobre o questions.json do repo (e some com "Restaurar padrão")
function quizFile() {
  if (process.env.QUESTIONS) return process.env.QUESTIONS;
  return fs.existsSync(UPLOAD_FILE) ? UPLOAD_FILE : DEFAULT_FILE;
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
    phase: PHASE.LOBBY,
    index: -1,
    /** @type {Map<string, {id:string,name:string,score:number,streak:number,best:number,answers:Map<string,object>,online:boolean,color:string}>} */
    players: new Map(),
    questionStartedAt: 0,
    lockedAt: 0,
    timer: null,
    // memo de um push: ranking e apuração são iguais para todos os clientes da
    // sala, então saem calculados uma vez por rodada e não uma vez por conexão
    memo: null,
  };
}

/** @type {Map<string, ReturnType<typeof makeRoom>>} */
const rooms = new Map();

// Ainda uma sala só — o roteamento por código entra no passo seguinte. O nome
// gritado é de propósito: enquanto existir, marca o que falta escopar.
const THE_ROOM = makeRoom(loadQuiz(), process.env.ROOM || makeCode(5));
rooms.set(THE_ROOM.code, THE_ROOM);

// ------------------------------------------------------- sessão salva em disco
// Fechar o terminal no meio do workshop não pode custar a pontuação da sala.
const SESSION_FILE = path.join(ROOT, 'session.json');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // sessão de ontem não serve para hoje

// impressão digital do questionário: pontuação de outro quiz não faz sentido
function quizFingerprint(room) {
  return room.quiz.missing ? 'none' : room.quiz.questions.map((q) => q.id).join(',');
}

function sessionSnapshot(room) {
  return {
    savedAt: new Date().toISOString(),
    room: room.code,
    fingerprint: quizFingerprint(room),
    index: room.index,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, ip: p.ip, color: p.color,
      score: p.score, streak: p.streak, best: p.best,
      answers: Object.fromEntries(p.answers),
    })),
  };
}

let saveTimer = null;

// agrupa rajadas de resposta num único write (o push de estado é o funil de tudo)
function scheduleSessionSave(room) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!room.players.size && room.index < 0) return; // nada que valha salvar
    fs.writeFile(SESSION_FILE, JSON.stringify(sessionSnapshot(room)), 'utf8', (err) => {
      if (err) console.log(`  !! não consegui salvar session.json: ${err.message}`);
    });
  }, 800);
}

function saveSessionNow(room) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!room.players.size && room.index < 0) return;
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionSnapshot(room)), 'utf8');
  } catch (e) {
    console.log(`  !! não consegui salvar session.json: ${e.message}`);
  }
}

function dropSession() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { fs.unlinkSync(SESSION_FILE); } catch { /* já não existia */ }
}

// devolve um resumo do que foi restaurado, ou null
function restoreSession(room) {
  let snap;
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    snap = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) {
    console.log(`  !! session.json ilegível, ignorando: ${e.message}`);
    return null;
  }
  const idade = Date.now() - Date.parse(snap.savedAt || 0);
  if (!(idade >= 0) || idade > SESSION_TTL_MS) return null;
  if (snap.fingerprint !== quizFingerprint(room)) return null; // outro questionário
  if (!Array.isArray(snap.players) || !snap.players.length) return null;

  for (const p of snap.players) {
    room.players.set(p.id, {
      id: p.id, name: p.name, ip: p.ip, color: p.color,
      score: p.score || 0, streak: p.streak || 0, best: p.best || 0,
      answers: new Map(Object.entries(p.answers || {})),
      online: false, // só a conexão SSE afirma presença
    });
  }
  room.index = Number.isInteger(snap.index) ? snap.index : -1;
  // uma pergunta que estava aberta não pode ter o relógio retomado: volta para a
  // leitura da mesma pergunta, e quem já respondeu continua com a resposta dada
  room.phase = snap.phase === PHASE.QUESTION ? PHASE.PROMPT : (snap.phase || PHASE.LOBBY);
  if (room.index < 0 || room.index >= room.quiz.questions.length) {
    room.index = -1;
    room.phase = PHASE.LOBBY;
  }
  return { players: room.players.size, index: room.index, phase: room.phase, minutos: Math.round(idade / 60000) };
}

// ------------------------------------------------------------------ SSE hub

let sseId = 0;
/** @type {Map<number, {res: http.ServerResponse, role: string, playerId: string|null}>} */
const clients = new Map();

function sseSend(entry, event, data) {
  try {
    entry.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client vanished; cleanup happens on 'close' */
  }
}

function broadcast(event, dataFor) {
  for (const entry of clients.values()) {
    const payload = typeof dataFor === 'function' ? dataFor(entry) : dataFor;
    if (payload !== null) sseSend(entry, event, payload);
  }
}

function pushState(room) {
  room.memo = {};
  try {
    const host = hostView(room); // idêntico para todos os apresentadores
    broadcast('state', (entry) => (entry.role === 'host' ? host : playerView(room, entry.playerId)));
  } finally {
    room.memo = null;
  }
  scheduleSessionSave(room);
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
    joinUrl: PUBLIC_URL ? PUBLIC_URL + '/play' : '',
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
      custom: quizFile() === UPLOAD_FILE,
      missing: !!room.quiz.missing,          // nada carregado: a tela pede o upload
      problems: room.quiz.problems || [],    // ou o arquivo existe mas está inválido
      hasDefault: fs.existsSync(DEFAULT_FILE),
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
  broadcast('countdown', { seconds: q.seconds, untimed: !!q.untimed, secondsLeft: q.seconds });
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
    dropSession();
  } else {
    for (const p of [...room.players.values()]) {
      if (!p.online) { removed.push(p.name); room.players.delete(p.id); continue; }
      p.score = 0; p.streak = 0; p.best = 0; p.answers.clear();
    }
  }
  room.quiz = loadQuiz();
  pushState(room);
  return { ok: true, removed, kept: room.players.size };
}

// ---------------------------------------------------------- troca do questionário

function installQuiz(room, raw) {
  if (process.env.QUESTIONS)
    return { ok: false, error: 'o servidor foi iniciado com QUESTIONS=… — troque pelo arquivo ou reinicie sem a variável' };
  let prepared;
  try {
    prepared = prepareQuiz(raw);
  } catch (e) {
    if (e instanceof QuizError) return { ok: false, error: 'JSON inválido', problems: e.problems };
    return { ok: false, error: String(e.message || e) };
  }
  // grava para sobreviver a um restart no meio do workshop — mas pasta somente
  // leitura, disco cheio ou antivírus não podem derrubar o servidor
  try {
    fs.writeFileSync(UPLOAD_FILE, JSON.stringify(raw, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: `não consegui gravar ${path.basename(UPLOAD_FILE)}: ${e.message}` };
  }
  room.quiz = prepared;
  room.quiz.source = path.basename(UPLOAD_FILE);
  resetGame(room, false);
  console.log(`  questionário trocado: ${room.quiz.title} · ${room.quiz.questions.length} perguntas · ${room.quiz.blocks.length} bloco(s)`);
  return { ok: true, title: room.quiz.title, count: room.quiz.questions.length, blocks: room.quiz.blocks.length };
}

function restoreDefaultQuiz(room) {
  if (process.env.QUESTIONS) return { ok: false, error: 'servidor iniciado com QUESTIONS=…' };
  if (!fs.existsSync(DEFAULT_FILE))
    return { ok: false, error: 'não existe questions.json no projeto para voltar' };
  try { fs.unlinkSync(UPLOAD_FILE); } catch { /* já era o padrão */ }
  room.quiz = loadQuiz();
  resetGame(room, false);
  return { ok: true, title: room.quiz.title, count: room.quiz.questions.length };
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
  if (ip && p.ip && ip !== p.ip)
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
    broadcast('allin', { id: q.id });
  }
  return { ok: true };
}

function join(room, name, ip) {
  // corpo hostil não pode virar exceção: {"name":{"toString":1}} quebrava o String()
  name = (typeof name === 'string' ? name : '').trim().replace(/\s+/g, ' ').slice(0, 18);
  if (!name) return { ok: false, error: 'digite um nome' };

  // nome repetido só passa se vier do mesmo IP que o criou — aí é a mesma pessoa
  // voltando (trocou de aba, limpou o navegador, caiu a rede) e recupera a pontuação
  const taken = [...room.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (taken) {
    if (taken.ip !== ip) return { ok: false, error: 'esse nome já está na sala' };
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
  room.players.set(id, { id, name, ip, score: 0, streak: 0, best: 0, answers: new Map(), online: false, color });
  broadcast('joined', { name, color, count: room.players.size });
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
    console.log(`  !! erro em ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
    try {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'erro interno' });
      else res.end();
    } catch { /* conexão já foi */ }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/events') {
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const playerId = url.searchParams.get('pid');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const id = ++sseId;
    const room = THE_ROOM;
    const entry = { res, role, playerId: room.players.has(playerId) ? playerId : null };
    clients.set(id, entry);
    if (entry.playerId) room.players.get(entry.playerId).online = true;
    sseSend(entry, 'state', role === 'host' ? hostView(room) : playerView(room, entry.playerId));
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(id);
      if (entry.playerId) {
        const still = [...clients.values()].some((c) => c.playerId === entry.playerId);
        const pl = room.players.get(entry.playerId);
        if (pl && !still) { pl.online = false; pushState(room); }
      }
    });
    return;
  }

  if (p === '/api/room') return sendJson(res, 200, { room: THE_ROOM.code, title: THE_ROOM.quiz.title, phase: THE_ROOM.phase });

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
    const body = await readBody(req, p === '/api/host/quiz' ? 4e6 : 1e5);
    if (body.__tooBig) return sendJson(res, 413, { ok: false, error: 'arquivo grande demais (máx 4 MB)' });
    if (body.__badJson) return sendJson(res, 400, { ok: false, error: 'não consegui ler o JSON — confira vírgulas e chaves' });
    // a sala é resolvida DEPOIS do await: entre ler o corpo e despachar, ela
    // pode ter sido derrubada (no passo 3 isso vira lookup pelo código)
    const room = THE_ROOM;
    switch (p) {
      case '/api/host/quiz': {
        const r = installQuiz(room, body.quiz);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      case '/api/host/quiz/default': {
        const r = restoreDefaultQuiz(room);
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
    try {
      const QR = require(path.join(ROOT, 'public', 'qr.js'));
      const join = PUBLIC_URL ? PUBLIC_URL + '/play' : 'https://funquiz-sgn7.onrender.com/play';
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
    saveSessionNow(THE_ROOM);
  };
}
process.on('uncaughtException', guard('erro'));
process.on('unhandledRejection', guard('rejeição'));

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    saveSessionNow(THE_ROOM);
    console.log('\n  sessão salva em session.json — subindo de novo, a sala volta como estava.');
    process.exit(0);
  });
}

server.listen(PORT, () => {
  listening = true;
  const ips = lanAddresses();
  const retomada = restoreSession(THE_ROOM);
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
  if (retomada) {
    console.log('');
    console.log(`  sessão retomada (salva há ${retomada.minutos} min): ${retomada.players} participante(s), `
      + `${retomada.index >= 0 ? `pergunta ${retomada.index + 1}` : 'lobby'}, fase ${retomada.phase}`);
    console.log('  os participantes reconectam sozinhos · "Zerar ranking" limpa tudo');
  }
  console.log('');
  console.log(`  apresentador : http://localhost:${PORT}/host`);
  console.log(`  participante : http://localhost:${PORT}/play`);
  for (const ip of ips) console.log(`                 http://${ip}:${PORT}/play   <-- use este no projetor`);
  console.log('');
});
