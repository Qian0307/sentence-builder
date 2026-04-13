/**
 * Sentence Builder - Backend Server
 * Node.js + Express + Socket.io + Groq (免費 AI)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const OpenAI = require('openai');

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

// Groq 相容 OpenAI SDK，只需加 baseURL 即可切換
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// ─── In-Memory State ─────────────────────────────────────────────────────────

let currentWord = '';         // 當前單字
let roundActive = false;      // 是否開放作答
let currentRound = 0;         // 第幾輪（0 = 尚未開始）
const rounds = [];            // 每輪的資料 { roundNum, word, answers: [] }
let connectedStudents = 0;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── REST Routes ─────────────────────────────────────────────────────────────

app.get('/api/rounds', (req, res) => {
  res.json(rounds);
});

app.get('/api/current-word', (req, res) => {
  res.json({ word: currentWord, roundActive, currentRound });
});

// ─── AI 評估 ─────────────────────────────────────────────────────────────────

async function evaluateSentence(word, sentence) {
  const prompt = `你是一位英文老師，正在批改學生的造句練習。

目標單字：「${word}」
學生的句子：「${sentence}」

請評估這個句子，並且只回傳一個合法的 JSON 物件（不要加任何 markdown 符號）：
{
  "grammar": true 或 false,
  "uses_word": true 或 false,
  "meaningful": true 或 false,
  "score": 0 到 100 的整數,
  "feedback": "用繁體中文給學生一到兩句具體的建議。",
  "example": "用「${word}」這個單字造一個好的範例句子（英文）。"
}

計分標準：
- 滿分 100 分
- 文法錯誤扣 30 分
- 沒有使用目標單字扣 30 分
- 句子不合邏輯或沒有意義扣 20 分
- 句子太短或用字很弱可小扣分`;

  const response = await openai.chat.completions.create({
    model: 'llama-3.1-8b-instant', // Groq 免費模型，速度極快
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  return JSON.parse(response.choices[0].message.content);
}

// ─── Socket.io Events ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const role = socket.handshake.query.role; // 'teacher' or 'student'
  console.log(`[+] ${role} 連線: ${socket.id}`);

  if (role === 'student') {
    connectedStudents++;
    io.emit('student_count', { count: connectedStudents });
  }

  // 連線時把目前狀態送給新加入的 client
  socket.emit('init', {
    word: currentWord,
    roundActive,
    currentRound,
    rounds: role === 'teacher' ? rounds : [],
    studentCount: connectedStudents,
  });

  // ── 老師：開始新一輪 ──────────────────────────────────────
  socket.on('start_round', ({ word }) => {
    if (role !== 'teacher') return;

    currentWord = word.trim();
    roundActive = true;
    currentRound++;

    // 建立新一輪的資料容器
    rounds.push({ roundNum: currentRound, word: currentWord, answers: [] });

    console.log(`[第${currentRound}輪開始] 單字：${currentWord}`);

    // 廣播給所有人
    io.emit('round_started', { word: currentWord, roundNum: currentRound });
  });

  // ── 老師：結束本輪 ────────────────────────────────────────
  socket.on('end_round', () => {
    if (role !== 'teacher') return;
    if (!roundActive) return;

    roundActive = false;
    console.log(`[第${currentRound}輪結束]`);

    io.emit('round_ended', { roundNum: currentRound });
  });

  // ── 學生：提交句子 ────────────────────────────────────────
  socket.on('submit_sentence', async ({ sentence, studentName }) => {
    if (role !== 'student') return;

    const name = (studentName || '匿名').trim().slice(0, 40);
    const trimmedSentence = (sentence || '').trim();

    if (!currentWord) {
      socket.emit('evaluation_result', { error: '老師還沒有設定單字，請稍候。' });
      return;
    }

    if (!roundActive) {
      socket.emit('evaluation_result', { error: '本輪已結束，請等待老師開始下一輪。' });
      return;
    }

    if (!trimmedSentence) {
      socket.emit('evaluation_result', { error: '請先輸入句子。' });
      return;
    }

    socket.emit('evaluating', true);

    try {
      const result = await evaluateSentence(currentWord, trimmedSentence);

      const entry = {
        id: Date.now(),
        studentName: name,
        word: currentWord,
        roundNum: currentRound,
        sentence: trimmedSentence,
        result,
        timestamp: new Date().toISOString(),
      };

      // 存進對應輪次
      const round = rounds.find(r => r.roundNum === currentRound);
      if (round) round.answers.push(entry);

      // 回傳給學生
      socket.emit('evaluation_result', {
        result,
        sentence: trimmedSentence,
        word: currentWord,
      });

      // 推送給老師看板
      io.emit('new_answer', entry);

    } catch (err) {
      console.error('[Groq Error]', err.message);
      socket.emit('evaluation_result', {
        error: 'AI 批改失敗，請確認 API Key 是否正確。',
      });
    } finally {
      socket.emit('evaluating', false);
    }
  });

  // ── 斷線清理 ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (role === 'student') {
      connectedStudents = Math.max(0, connectedStudents - 1);
      io.emit('student_count', { count: connectedStudents });
    }
    console.log(`[-] ${role} 離線: ${socket.id}`);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`   Teacher: http://localhost:${PORT}/teacher.html`);
  console.log(`   Student: http://localhost:${PORT}/student.html\n`);
});
