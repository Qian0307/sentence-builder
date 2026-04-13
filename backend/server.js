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

// Allow all origins in dev; restrict in production via env var
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

let currentWord = '';               // The active word set by the teacher
const answerHistory = [];           // All submitted answers this session
let connectedStudents = 0;          // Live student count (teachers excluded)

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

// Serve the frontend folder as static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── REST Routes ─────────────────────────────────────────────────────────────

// Return full answer history (useful for page reload / teacher dashboard)
app.get('/api/history', (req, res) => {
  res.json(answerHistory);
});

// Return the current word (useful on student page load)
app.get('/api/current-word', (req, res) => {
  res.json({ word: currentWord });
});

// ─── OpenAI Evaluation ───────────────────────────────────────────────────────

/**
 * Send the sentence + target word to GPT for evaluation.
 * Returns a structured JSON result.
 */
async function evaluateSentence(word, sentence) {
  const prompt = `You are an English teacher evaluating a student's sentence exercise.

Target word: "${word}"
Student's sentence: "${sentence}"

Evaluate the sentence and respond with ONLY a valid JSON object (no markdown fences):
{
  "grammar": true or false,
  "uses_word": true or false,
  "meaningful": true or false,
  "score": integer from 0 to 100,
  "feedback": "One or two sentences of constructive feedback for the student.",
  "example": "A good example sentence using the word '${word}'."
}

Scoring guide:
- Start at 100
- Deduct 30 if grammar is wrong
- Deduct 30 if the target word is not used
- Deduct 20 if the sentence is not meaningful
- Minor deductions for weak vocabulary or very short sentences`;

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
  console.log(`[+] ${role} connected: ${socket.id}`);

  if (role === 'student') {
    connectedStudents++;
    // Notify all teachers of updated count
    io.emit('student_count', { count: connectedStudents });
  }

  // ── On connect: send current state to the joining client ──
  socket.emit('init', {
    word: currentWord,
    history: role === 'teacher' ? answerHistory : [],
    studentCount: connectedStudents,
  });

  // ── Teacher sets a new word ──────────────────────────────
  socket.on('set_word', ({ word }) => {
    if (role !== 'teacher') return; // only teachers can set the word

    currentWord = word.trim();
    console.log(`[Word] Set to: "${currentWord}"`);

    // Broadcast new word to ALL connected clients
    io.emit('word_update', { word: currentWord });
  });

  // ── Student submits a sentence ───────────────────────────
  socket.on('submit_sentence', async ({ sentence, studentName }) => {
    if (role !== 'student') return;

    const name = (studentName || 'Anonymous').trim().slice(0, 40);
    const trimmedSentence = (sentence || '').trim();

    // Guard: word must be set
    if (!currentWord) {
      socket.emit('evaluation_result', {
        error: 'The teacher has not set a word yet. Please wait.',
      });
      return;
    }

    // Guard: sentence must not be empty
    if (!trimmedSentence) {
      socket.emit('evaluation_result', { error: 'Please write a sentence first.' });
      return;
    }

    // Notify the submitting student that evaluation is in progress
    socket.emit('evaluating', true);

    try {
      const result = await evaluateSentence(currentWord, trimmedSentence);

      const entry = {
        id: Date.now(),
        studentName: name,
        word: currentWord,
        sentence: trimmedSentence,
        result,
        timestamp: new Date().toISOString(),
      };

      // Persist in session history
      answerHistory.push(entry);

      // Send full result back to the submitting student
      socket.emit('evaluation_result', {
        result,
        sentence: trimmedSentence,
        word: currentWord,
      });

      // Push the new entry to the teacher dashboard (all teachers)
      io.emit('new_answer', entry);

    } catch (err) {
      console.error('[Groq Error]', err.message);
      socket.emit('evaluation_result', {
        error: 'AI evaluation failed. Check your API key or try again.',
      });
    } finally {
      socket.emit('evaluating', false);
    }
  });

  // ── Disconnect cleanup ───────────────────────────────────
  socket.on('disconnect', () => {
    if (role === 'student') {
      connectedStudents = Math.max(0, connectedStudents - 1);
      io.emit('student_count', { count: connectedStudents });
    }
    console.log(`[-] ${role} disconnected: ${socket.id}`);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`   Teacher: http://localhost:${PORT}/teacher.html`);
  console.log(`   Student: http://localhost:${PORT}/student.html\n`);
});
