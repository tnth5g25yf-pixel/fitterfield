const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AI_MODEL = process.env.FITTERFIELD_AI_MODEL || 'gpt-5.6-luna';
const TRANSCRIBE_MODEL = process.env.FITTERFIELD_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const ALLOWED_ORIGINS = (process.env.FITTERFIELD_APP_ORIGIN || 'https://fitterfield-pro-app.onrender.com')
  .split(',').map(x => x.trim()).filter(Boolean);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));
app.use(express.json({ limit: '1mb' }));

const SYSTEM_PROMPT = `You are FitterField AI, the field assistant built into the FitterField app for fire sprinkler professionals.

Your job is to make field work easier, faster, clearer, and safer.

Style:
- Be practical and concise.
- Explain trade concepts in plain language when helpful.
- Prefer step-by-step answers when the user is trying to do something in the field.
- Ask a focused clarification question only when the missing detail materially changes the answer.
- Never pretend to have seen drawings, plans, measurements, code editions, or manufacturer instructions that were not provided.
- When calculations are needed, show the math and the final result.
- For code, design, inspection, life-safety, or job-specific requirements, distinguish general guidance from requirements that must be verified against the applicable NFPA standard, adopted code, approved plans, AHJ direction, and manufacturer instructions.
- Do not invent NFPA section numbers or manufacturer requirements.
- Encourage safe work practices and appropriate qualified review for high-consequence decisions.

FitterField app capabilities include feet/inches conversion, fraction/decimal conversion, pipe-run math, job notes, workbook lessons, challenges, and progress tracking.`;

function requireAI(res) {
  if (!openai) {
    res.status(503).json({
      error: 'FitterField AI is not configured yet.',
      fix: 'Add OPENAI_API_KEY to the Render environment for the fitterfield-ai service.'
    });
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(openai), model: AI_MODEL });
});

app.post('/api/chat', async (req, res) => {
  if (!requireAI(res)) return;
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  try {
    const response = await openai.responses.create({
      model: AI_MODEL,
      instructions: SYSTEM_PROMPT,
      input: message,
      max_output_tokens: 700
    });
    res.json({ answer: response.output_text || 'I could not generate an answer.' });
  } catch (err) {
    console.error('AI chat failed:', err);
    res.status(500).json({ error: 'FitterField AI could not answer that right now.' });
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!requireAI(res)) return;
  if (!req.file) return res.status(400).json({ error: 'Audio is required.' });

  try {
    const ext = req.file.mimetype.includes('webm') ? 'webm'
      : req.file.mimetype.includes('mp4') ? 'mp4'
      : req.file.mimetype.includes('mpeg') ? 'mp3'
      : 'webm';
    const filename = `fitterfield-voice.${ext}`;
    const file = await OpenAI.toFile(req.file.buffer, filename, { type: req.file.mimetype || 'audio/webm' });
    const transcript = await openai.audio.transcriptions.create({
      file,
      model: TRANSCRIBE_MODEL
    });
    res.json({ text: transcript.text || '' });
  } catch (err) {
    console.error('Transcription failed:', err);
    res.status(500).json({ error: 'Voice transcription failed. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`FitterField AI listening on ${PORT}`);
  if (!OPENAI_API_KEY) console.warn('OPENAI_API_KEY is missing. Add it in Render to enable AI.');
});
