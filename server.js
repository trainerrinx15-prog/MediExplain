/* ═══════════════════════════════════════════════════════
   server.js — Prescripto AI Backend
   Stack: Node.js + Express
   Handles: Receive encrypted OCR text → Decrypt →
            Call Gemini API → Return explanation

   HOW TO RUN:
     npm install express cors node-fetch
     node server.js

   For Replit: add dependencies in package.json,
   then run with "node server.js"
═══════════════════════════════════════════════════════ */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// ── CUSTOMIZE: Paste your Gemini API key here ────────
// Get yours at: https://makersuite.google.com/app/apikey
// IMPORTANT: In production, use process.env.GEMINI_API_KEY
// e.g. set it in Replit Secrets as GEMINI_API_KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDQsB8PVGTKgcI3FnkXzqXI5lEzEK4K1oc';

// CUSTOMIZE: Gemini model to use
// Options: gemini-1.5-flash (fast/cheap), gemini-1.5-pro (more capable)
const GEMINI_MODEL = 'gemini-1.5-flash';

// ── Serve frontend static files ──────────────────────
app.use(express.static(__dirname));

/* ─────────────────────────────────────────────────────
   DECRYPTION — AES-256-GCM (mirrors frontend encryption)
───────────────────────────────────────────────────── */
async function decryptText(ciphertext, ivB64, keyB64) {
  const crypto = webcrypto;

  // Base64 → ArrayBuffer
  const cipherBuf  = base64ToArrayBuffer(ciphertext);
  const iv         = base64ToArrayBuffer(ivB64);
  const rawKey     = base64ToArrayBuffer(keyB64);

  // Import the AES-256-GCM key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  // Decrypt
  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    cipherBuf
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuf);
}

function base64ToArrayBuffer(b64) {
  const binary = Buffer.from(b64, 'base64');
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

/* ─────────────────────────────────────────────────────
   GEMINI API CALL
───────────────────────────────────────────────────── */
async function callGemini(extractedText) {
  // ── CUSTOMIZE: Edit the system prompt below ──────
  // The prompt tells Gemini how to explain the prescription.
  // IMPORTANT: The "NO medicine/dosage suggestions" rule is enforced here.
  const systemPrompt = `You are a medical document explainer. Your job is to read a prescription or lab report and explain it in simple, clear, plain language that any patient can understand.

STRICT RULES you must follow:
1. DO NOT suggest, recommend, or mention any medication, drug name, dosage, or treatment plan.
2. DO NOT give medical advice.
3. DO NOT diagnose any condition.
4. Only EXPLAIN what the document says in plain English — what each term means, what each test result indicates in general terms, and any important observations.
5. Structure your response with clear sections using **Section Name:** headings.
6. Keep explanations friendly, simple, and jargon-free.
7. End with a reminder to consult the prescribing doctor for any medical decisions.

If the text does not appear to be a medical document, politely say so.`;

  const userPrompt = `Please explain the following prescription or lab report in plain language:\n\n${extractedText}`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: systemPrompt + '\n\n' + userPrompt }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,      // low temp for factual/reliable output
      maxOutputTokens: 1500, // CUSTOMIZE: increase for longer reports
      topP: 0.9,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_MEDICAL',         threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT',      threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',     threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ]
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[Gemini API Error]', res.status, errBody);

    // Friendly error messages
    if (res.status === 400) throw new Error('Gemini API: Invalid request. Check your API key.');
    if (res.status === 403) throw new Error('Gemini API: Access denied. Check your API key permissions.');
    if (res.status === 429) throw new Error('Gemini API: Rate limit reached. Please try again shortly.');
    throw new Error(`Gemini API error ${res.status}`);
  }

  const data = await res.json();

  // Extract text from Gemini response
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('[Gemini] Unexpected response structure:', JSON.stringify(data, null, 2));
    throw new Error('Gemini returned an empty or unexpected response.');
  }

  return text;
}

/* ─────────────────────────────────────────────────────
   POST /api/analyse
   Receives: { ciphertext, iv, key, fileName }
   Returns:  { explanation }
───────────────────────────────────────────────────── */
app.post('/api/analyse', async (req, res) => {
  const { ciphertext, iv, key, fileName } = req.body;

  // Basic validation
  if (!ciphertext || !iv || !key) {
    return res.status(400).json({ error: 'Missing required fields: ciphertext, iv, key' });
  }

  console.log(`[Prescripto] Received request for: ${fileName || 'unknown'}`);

  try {
    // 1. Decrypt the OCR text
    let plaintext;
    try {
      plaintext = await decryptText(ciphertext, iv, key);
    } catch (e) {
      console.error('[Decrypt error]', e.message);
      return res.status(400).json({ error: 'Decryption failed. Data may be corrupted.' });
    }

    if (!plaintext || plaintext.trim().length < 10) {
      return res.status(400).json({ error: 'Decrypted text is too short or empty.' });
    }

    console.log(`[Prescripto] Decrypted ${plaintext.length} chars, calling Gemini…`);

    // 2. Call Gemini API
    const explanation = await callGemini(plaintext);

    console.log(`[Prescripto] Gemini responded (${explanation.length} chars)`);

    // 3. Return explanation (we do NOT store any plaintext)
    return res.json({ explanation });

  } catch (err) {
    console.error('[Prescripto Error]', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────────────────── */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model:  GEMINI_MODEL,
    time:   new Date().toISOString(),
  });
});

/* ─────────────────────────────────────────────────────
   START SERVER
   CUSTOMIZE: Change port if needed
───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Prescripto AI running at http://localhost:${PORT}`);
  console.log(`   Model: ${GEMINI_MODEL}`);
  if (GEMINI_API_KEY === 'PASTE_YOUR_GEMINI_API_KEY_HERE') {
    console.warn('\n⚠️  WARNING: Gemini API key not set!');
    console.warn('   Edit server.js and paste your key, or set GEMINI_API_KEY env variable.\n');
  }
});
