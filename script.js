/* ═══════════════════════════════════════════════════════
   script.js — Prescripto AI Frontend
   Handles: File upload, OCR (Tesseract.js),
            AES-256-GCM encryption, backend fetch
═══════════════════════════════════════════════════════ */

// ── CUSTOMIZE: Change this to your backend URL if different
// For Replit: leave as-is (same-origin). For custom host, e.g. "https://my-app.repl.co"
const BACKEND_URL = '';  // empty = same origin

// ── Audit log (session only, cleared on refresh)
const auditLog = [];

// ── Selected file state
let selectedFile = null;

/* ─────────────────────────────────────────────────────
   AUDIT LOG HELPERS
───────────────────────────────────────────────────── */
function addAuditEntry(event, detail = '') {
  const entry = {
    time: new Date().toLocaleTimeString(),
    event,
    detail,
  };
  auditLog.unshift(entry); // newest first
  refreshAuditUI();
}

function refreshAuditUI() {
  const list = document.getElementById('auditLogList');
  if (!list) return;
  if (auditLog.length === 0) {
    list.innerHTML = '<p class="text-sm text-ink/40 italic">No entries yet.</p>';
    return;
  }
  list.innerHTML = auditLog.map(e => `
    <div class="audit-entry">
      <span class="audit-time">${e.time}</span>
      <span class="audit-event"> · ${e.event}</span>
      ${e.detail ? `<br/><span class="audit-detail">${e.detail}</span>` : ''}
    </div>
  `).join('');
}

/* ─────────────────────────────────────────────────────
   ENCRYPTION PILL HELPERS
───────────────────────────────────────────────────── */
function setEncryptionPill(state, label) {
  const pill = document.getElementById('encryptionPill');
  if (!pill) return;
  pill.className = `enc-pill enc-${state}`;
  pill.querySelector('.enc-label').textContent = label;
}

/* ─────────────────────────────────────────────────────
   PROGRESS STEP HELPERS
───────────────────────────────────────────────────── */
function setStep(stepId, status, detail = '') {
  const step   = document.getElementById(`step-${stepId}`);
  const status_ = document.getElementById(`step-${stepId}-status`);
  const detail_ = document.getElementById(`step-${stepId}-detail`);
  if (!step) return;

  step.classList.remove('active', 'done');
  status_.classList.remove('active', 'done', 'error');

  if (status === 'active') {
    step.classList.add('active');
    status_.classList.add('active');
    status_.textContent = '●';
  } else if (status === 'done') {
    step.classList.add('done');
    status_.classList.add('done');
    status_.textContent = '✓';
  } else if (status === 'error') {
    status_.classList.add('error');
    status_.textContent = '✕';
  } else {
    status_.textContent = '○';
  }

  if (detail && detail_) detail_.textContent = detail;
}

function setProgress(pct) {
  const bar = document.getElementById('progressFill');
  if (bar) bar.style.width = pct + '%';
}

/* ─────────────────────────────────────────────────────
   FILE HANDLING
───────────────────────────────────────────────────── */
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) loadFile(file);
}

function handleDragOver(event) {
  event.preventDefault();
  document.getElementById('dropZone').classList.add('drag-over');
}

function handleDragLeave(event) {
  document.getElementById('dropZone').classList.remove('drag-over');
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('dropZone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) loadFile(file);
}

function loadFile(file) {
  // Validate type
  const allowed = ['image/jpeg','image/png','image/tiff','image/bmp','image/webp','application/pdf'];
  if (!allowed.includes(file.type)) {
    showError('Unsupported file type. Please upload an image (JPG, PNG, TIFF, BMP) or PDF.');
    return;
  }
  // Validate size (max 20MB)
  if (file.size > 20 * 1024 * 1024) {
    showError('File too large. Please upload a file under 20 MB.');
    return;
  }

  selectedFile = file;
  addAuditEntry('File selected', `${file.name} (${formatSize(file.size)})`);

  // Show preview
  const dropContent  = document.getElementById('dropContent');
  const prevContent  = document.getElementById('previewContent');
  const prevImg      = document.getElementById('previewImg');
  const pdfPrev      = document.getElementById('pdfPreview');
  const fileNameEl   = document.getElementById('fileName');
  const fileSizeEl   = document.getElementById('fileSize');

  dropContent.classList.add('hidden');
  prevContent.classList.remove('hidden');
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatSize(file.size);

  if (file.type === 'application/pdf') {
    prevImg.classList.add('hidden');
    pdfPrev.classList.remove('hidden');
  } else {
    pdfPrev.classList.add('hidden');
    prevImg.classList.remove('hidden');
    const reader = new FileReader();
    reader.onload = e => { prevImg.src = e.target.result; };
    reader.readAsDataURL(file);
  }

  // Enable button
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = false;
  document.getElementById('analyzeBtnText').textContent = 'Analyse Document';
  hideError();
}

function resetFile() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('dropContent').classList.remove('hidden');
  document.getElementById('previewContent').classList.add('hidden');
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true;
  document.getElementById('analyzeBtnText').textContent = 'Select a file to analyse';
  addAuditEntry('File removed');
}

function resetAll() {
  resetFile();
  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('progressCard').classList.add('hidden');
  setEncryptionPill('idle', 'Idle');
  setProgress(0);
  ['ocr','encrypt','ai'].forEach(s => setStep(s, 'idle', 'Waiting…'));
  hideError();
}

/* ─────────────────────────────────────────────────────
   AES-256-GCM ENCRYPTION (Web Crypto API)
   All encryption runs 100% client-side in the browser.
───────────────────────────────────────────────────── */
async function encryptText(plaintext) {
  const enc     = new TextEncoder();
  const keyMat  = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const iv         = crypto.getRandomValues(new Uint8Array(12));  // 96-bit IV
  const cipherBuf  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keyMat,
    enc.encode(plaintext)
  );
  // Export key so backend can decrypt
  const rawKey = await crypto.subtle.exportKey('raw', keyMat);

  // Return base64-encoded payload
  return {
    ciphertext: arrayBufferToBase64(cipherBuf),
    iv:         arrayBufferToBase64(iv.buffer),
    key:        arrayBufferToBase64(rawKey),
  };
}

/* ─────────────────────────────────────────────────────
   OCR — Tesseract.js
───────────────────────────────────────────────────── */
async function extractTextOCR(file) {
  // For PDFs: we send file directly; Tesseract handles image conversion
  // Note: Tesseract.js works best with images. For complex PDFs, the
  // backend can also do server-side OCR if needed.
  const worker = await Tesseract.createWorker('eng', 1, {
    // logger: m => console.log('[Tesseract]', m)  // uncomment to debug
  });

  const result = await worker.recognize(file);
  await worker.terminate();
  return result.data.text.trim();
}

/* ─────────────────────────────────────────────────────
   MAIN ANALYSIS PIPELINE
───────────────────────────────────────────────────── */
async function runAnalysis() {
  if (!selectedFile) return;

  const btn        = document.getElementById('analyzeBtn');
  const btnText    = document.getElementById('analyzeBtnText');
  const btnSpinner = document.getElementById('btnSpinner');
  const progCard   = document.getElementById('progressCard');

  // Show progress card
  progCard.classList.remove('hidden');
  btn.disabled = true;
  btnText.textContent = 'Analysing…';
  btnSpinner.classList.remove('hidden');
  hideError();

  addAuditEntry('Analysis started', selectedFile.name);

  try {
    // ── STEP 1: OCR ───────────────────────────────────
    setStep('ocr', 'active', 'Extracting text…');
    setEncryptionPill('active', 'OCR running');
    setProgress(10);

    let extractedText;
    try {
      extractedText = await extractTextOCR(selectedFile);
    } catch (e) {
      throw new Error('OCR failed: ' + e.message);
    }

    if (!extractedText || extractedText.length < 10) {
      throw new Error('Could not extract readable text. Try a clearer image.');
    }

    setStep('ocr', 'done', `Extracted ${extractedText.length} characters`);
    addAuditEntry('OCR complete', `${extractedText.length} chars extracted`);
    setProgress(40);

    // ── STEP 2: ENCRYPTION ────────────────────────────
    setStep('encrypt', 'active', 'Encrypting with AES-256-GCM…');
    setEncryptionPill('active', 'Encrypting');

    let encrypted;
    try {
      encrypted = await encryptText(extractedText);
    } catch (e) {
      throw new Error('Encryption failed: ' + e.message);
    }

    setStep('encrypt', 'done', 'AES-256-GCM encrypted · IV generated');
    setEncryptionPill('secure', 'Encrypted');
    addAuditEntry('Encryption complete', 'AES-256-GCM · key ephemeral · client-side');
    setProgress(60);

    // ── STEP 3: GEMINI AI CALL ────────────────────────
    setStep('ai', 'active', 'Sending to Gemini AI…');

    let explanation;
    try {
      const response = await fetch(`${BACKEND_URL}/api/analyse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ciphertext: encrypted.ciphertext,
          iv:         encrypted.iv,
          key:        encrypted.key,
          fileName:   selectedFile.name,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown server error' }));
        throw new Error(err.error || `Server error ${response.status}`);
      }

      const data = await response.json();
      explanation = data.explanation;
    } catch (e) {
      throw new Error('AI call failed: ' + e.message);
    }

    setStep('ai', 'done', 'Gemini AI responded');
    setEncryptionPill('secure', 'Secure ✓');
    addAuditEntry('Gemini AI responded', 'Explanation received');
    setProgress(100);

    // ── RENDER RESULTS ────────────────────────────────
    showResults(explanation);

  } catch (err) {
    // Mark whichever step was active as errored
    ['ocr','encrypt','ai'].forEach(s => {
      const el = document.getElementById(`step-${s}-status`);
      if (el && el.classList.contains('active')) {
        setStep(s, 'error', err.message);
      }
    });
    setEncryptionPill('error', 'Error');
    addAuditEntry('Error', err.message);
    showError(err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Analyse Document';
    btnSpinner.classList.add('hidden');
  }
}

/* ─────────────────────────────────────────────────────
   RENDER RESULTS
───────────────────────────────────────────────────── */
function showResults(explanation) {
  const section   = document.getElementById('resultsSection');
  const bodyEl    = document.getElementById('aiExplanation');
  const tsEl      = document.getElementById('resultTimestamp');

  // Format the explanation as HTML
  // The backend returns plain text with section headers like **Header:**
  // We convert it to styled HTML.
  const formatted = formatExplanation(explanation);
  bodyEl.innerHTML = formatted;

  tsEl.textContent = new Date().toLocaleString();
  section.classList.remove('hidden');

  // Scroll to results
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatExplanation(text) {
  // Convert markdown-style bold headers to <h2>
  // Convert **text** to <strong>
  // Convert newlines to <p> breaks
  let html = text
    .replace(/\*\*(.*?):\*\*/g, (_, h) => `</p><h2>${h}</h2><p>`) // **Header:**
    .replace(/\*\*(.*?)\*\*/g, (_, t) => `<strong>${t}</strong>`)  // **bold**
    .replace(/\*(.*?)\*/g, (_, t) => `<em>${t}</em>`)              // *italic*
    .replace(/^- (.+)/gm, '<li>$1</li>')                            // - list items
    .split('\n\n').map(p => p.trim() ? `<p>${p}</p>` : '').join('');

  // Wrap list items
  html = html.replace(/(<li>.*?<\/li>\s*)+/gs, m => `<ul>${m}</ul>`);
  return html;
}

/* ─────────────────────────────────────────────────────
   ERROR DISPLAY
───────────────────────────────────────────────────── */
function showError(msg) {
  const banner = document.getElementById('errorBanner');
  const msgEl  = document.getElementById('errorMsg');
  msgEl.textContent = msg;
  banner.classList.remove('hidden');
}
function hideError() {
  document.getElementById('errorBanner').classList.add('hidden');
}

/* ─────────────────────────────────────────────────────
   AUDIT MODAL
───────────────────────────────────────────────────── */
function openAuditLog() {
  refreshAuditUI();
  document.getElementById('auditModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeAuditLog() {
  document.getElementById('auditModal').classList.add('hidden');
  document.body.style.overflow = '';
}
// Close modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAuditLog();
});

/* ─────────────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────────────── */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function formatSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
