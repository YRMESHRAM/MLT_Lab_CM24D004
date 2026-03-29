// ============================================================
//  SignSense — app.js
//  Fixes: camera start bug, upload→re-enable START,
//         proper prediction, word builder, TTS
// ============================================================

const MODEL_URL            = "./my_model/";
const CONFIDENCE_THRESHOLD  = 0.60;
const STABILIZATION_THRESHOLD = 15; // Fast response (~0.5s)

// ── State ──
let model          = null;
let webcam         = null;
let labelContainer = null;
let maxPredictions = 0;
let isLooping      = false;
let cameraActive   = false;
let modelLoaded    = false;
let currentLetter  = null;
let wordBuffer      = "";
let sentenceHistory = [];
let lastGridLetter  = null;

// Stabilization state for auto-add
let stableFrames        = 0;
let lastAutoAddedLetter = null;
let canAddNext          = true;

const $ = id => document.getElementById(id);

// ────────────────────────────────────────────
//  INIT
// ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  buildAlphabetGrid();
  updateWordDisplay();
  $("btn-stop").disabled = true;
});

function buildAlphabetGrid() {
  const grid = $("alpha-grid");
  for (let i = 65; i <= 90; i++) {
    const ch   = String.fromCharCode(i);
    const tile = document.createElement("div");
    tile.classList.add("alpha-tile");
    tile.textContent = ch;
    tile.id = "tile-" + ch;
    grid.appendChild(tile);
  }
}

// ────────────────────────────────────────────
//  MODEL LOADING  (shared)
// ────────────────────────────────────────────
async function ensureModelLoaded() {
  if (modelLoaded && model) return true;

  setHint("Loading model, please wait…");
  try {
    model = await tmImage.load(
      MODEL_URL + "model.json",
      MODEL_URL + "metadata.json"
    );
    maxPredictions = model.getTotalClasses();

    // Build hidden label container
    labelContainer = $("label-container");
    labelContainer.innerHTML = "";
    for (let i = 0; i < maxPredictions; i++) {
      labelContainer.appendChild(document.createElement("div"));
    }

    modelLoaded = true;
    setPill("pill-model", "pill-model-text", "Model Ready", true);
    return true;
  } catch (err) {
    console.error("[SignSense] Model load failed:", err);
    showToast("⚠ Could not load model — check the ./my_model/ folder.");
    setHint("Model load failed. Ensure model files are in ./my_model/");
    return false;
  }
}

// ────────────────────────────────────────────
//  START CAMERA
// ────────────────────────────────────────────
async function startCamera() {
  if (cameraActive) return;

  // Disable start right away — NO querySelector chaining, just toggle disabled
  $("btn-start").disabled = true;
  setHint("Loading model & requesting camera…");

  // Hide any upload preview leftover
  hideUploadPreview();

  const ok = await ensureModelLoaded();
  if (!ok) {
    $("btn-start").disabled = false;   // allow retry
    return;
  }

  try {
    webcam = new tmImage.Webcam(400, 400, true); // width, height, flip
    await webcam.setup();  // asks browser for camera permission
    await webcam.play();

    // Inject the webcam canvas into the frame
    const container = $("webcam-container");
    container.innerHTML = "";
    container.appendChild(webcam.canvas);

    cameraActive = true;
    isLooping    = true;

    // — UI on —
    $("cam-idle").classList.add("hidden");
    $("scanline").classList.add("on");
    $("live-dot").classList.add("on");
    $("live-badge").classList.add("on");
    $("live-text").textContent = "Live";
    setPill("pill-cam", "pill-cam-text", "Camera On", false, true);
    $("btn-start").disabled = true;
    $("btn-stop").disabled  = false;
    setHint("Camera active — show a hand sign clearly.");

    // Kick off RAF loop
    requestAnimationFrame(cameraLoop);

  } catch (err) {
    console.error("[SignSense] Camera error:", err);
    showToast("⚠ Camera access denied or unavailable.");
    setHint("Camera error: " + (err.message || "Unknown. Check browser permissions."));
    $("btn-start").disabled = false;
  }
}

// ────────────────────────────────────────────
//  STOP CAMERA
// ────────────────────────────────────────────
function stopCamera() {
  if (!cameraActive) return;

  isLooping    = false;
  cameraActive = false;

  if (webcam) {
    try { webcam.stop(); } catch (_) {}
    webcam = null;
  }

  // Clear canvas
  $("webcam-container").innerHTML = "";

  // — UI off —
  $("cam-idle").classList.remove("hidden");
  $("scanline").classList.remove("on");
  $("live-dot").classList.remove("on");
  $("live-badge").classList.remove("on");
  $("live-text").textContent = "Offline";
  setPill("pill-cam", "pill-cam-text", "Camera Off", false, false);
  $("btn-start").disabled = false;
  $("btn-stop").disabled  = true;

  resetDetection();
  setHint("Camera stopped. Press START to resume.");
}

// ────────────────────────────────────────────
//  CAMERA LOOP
// ────────────────────────────────────────────
async function cameraLoop() {
  if (!isLooping || !cameraActive || !webcam) return;
  webcam.update();
  await runPrediction(webcam.canvas);
  requestAnimationFrame(cameraLoop);
}

// ────────────────────────────────────────────
//  IMAGE UPLOAD
// ────────────────────────────────────────────
async function handleUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = ""; // reset so same file can be re-picked

  // Stop live camera if running
  if (cameraActive) stopCamera();

  const ok = await ensureModelLoaded();
  if (!ok) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const img = new Image();
    img.onload = async () => {
      // Show preview in frame
      $("upload-img").src = e.target.result;
      $("upload-preview").style.display = "flex";
      $("upload-badge").textContent = "Analyzing…";
      $("cam-idle").classList.add("hidden");

      // Draw to offscreen 224×224 canvas for prediction
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 224;
      canvas.getContext("2d").drawImage(img, 0, 0, 224, 224);

      await runPrediction(canvas);

      // For uploads, we store the result immediately if it's confident
      if (currentLetter) {
        addLetter();
        // Reset stabilization state so camera mode is ready for next sign
        lastAutoAddedLetter = currentLetter;
        canAddNext = false; 
      }

      // Update badge with result
      $("upload-badge").textContent = currentLetter
        ? "Detected: " + currentLetter
        : "Below threshold";

      // ✅ KEY FIX: Re-enable START so user can switch back to camera
      $("btn-start").disabled = false;
      setHint("Upload predicted. Press START to switch to live camera.");
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function hideUploadPreview() {
  $("upload-preview").style.display = "none";
}

// ────────────────────────────────────────────
//  CORE PREDICTION  (camera canvas OR image canvas)
// ────────────────────────────────────────────
async function runPrediction(src) {
  if (!model) return;

  let preds;
  try {
    preds = await model.predict(src);
  } catch (err) {
    console.error("[SignSense] Predict error:", err);
    return;
  }

  // Update debug label container
  for (let i = 0; i < maxPredictions; i++) {
    if (labelContainer && labelContainer.childNodes[i]) {
      labelContainer.childNodes[i].innerHTML =
        preds[i].className + ": " + preds[i].probability.toFixed(4);
    }
  }

  // Find top class
  let topProb = -1, topClass = "";
  for (const p of preds) {
    if (p.probability > topProb) {
      topProb  = p.probability;
      topClass = p.className.trim().toUpperCase();
    }
  }

  const pct         = Math.round(topProb * 100);
  const isConfident = topProb >= CONFIDENCE_THRESHOLD;

  // ── Confidence bar ──
  const fill = $("meter-fill");
  fill.style.width = pct + "%";
  $("meter-pct").textContent = pct + "%";
  fill.classList.toggle("confident", isConfident);
  $("meter-pct").classList.toggle("confident", isConfident);

  // ── Letter ring ──
  const charEl = $("letter-char");
  const ringEl = $("letter-ring");

  if (isConfident) {
    // Pop animation on change
    if (charEl.textContent !== topClass) {
      charEl.classList.remove("pop");
      void charEl.offsetWidth;           // force reflow
      charEl.classList.add("pop");
    }

    charEl.textContent = topClass;
    charEl.classList.add("confident");
    ringEl.classList.add("confident");
    $("letter-sub").textContent = topClass + " — " + pct + "% confident";

    highlightGrid(topClass);

    // ── Auto Add Logic ──
    if (currentLetter === topClass) {
      stableFrames++;
      
      // If we haven't added this specific instance of the letter yet
      if (stableFrames >= STABILIZATION_THRESHOLD && canAddNext) {
        addLetter();
        lastAutoAddedLetter = topClass;
        canAddNext = false; // Block until reset
      }
    } else {
      currentLetter = topClass;
      stableFrames = 1;
      // If letter changed, we can potentially add again if it's different
      if (topClass !== lastAutoAddedLetter) {
        canAddNext = true;
      }
    }

  } else {
    // Reset more strictly if confidence drops below threshold to avoid sticking
    stableFrames = 0;
    currentLetter = null;
    lastAutoAddedLetter = null;
    canAddNext = true;

    charEl.textContent = "?";
    charEl.classList.remove("confident");
    ringEl.classList.remove("confident");
    $("letter-sub").textContent = "Best: " + topClass + " (" + pct + "%) — below 60%";
    clearGrid();
  }
}

// ────────────────────────────────────────────
//  WORD BUILDER
// ────────────────────────────────────────────
function addLetter() {
  if (!currentLetter) { showToast("No confident letter detected."); return; }
  wordBuffer += currentLetter;
  updateWordDisplay();
  showToast("Added: " + currentLetter);
}

function addSpace() {
  wordBuffer += " ";
  updateWordDisplay();
}

function deleteLast() {
  if (!wordBuffer.length) return;
  wordBuffer = wordBuffer.slice(0, -1);
  updateWordDisplay();
}

function clearAll() {
  wordBuffer = "";
  updateWordDisplay();
}

function updateWordDisplay() {
  const ph = $("word-placeholder");
  const wt = $("word-text");
  if (wordBuffer.length === 0) {
    ph.style.display = "inline";
    wt.textContent   = "";
  } else {
    ph.style.display = "none";
    wt.textContent   = wordBuffer;
  }
}

function saveSentence() {
  const text = wordBuffer.trim();
  if (!text) { showToast("Nothing to save."); return; }
  sentenceHistory.unshift({
    text,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  });
  wordBuffer = "";
  updateWordDisplay();
  renderHistory();
  showToast("Sentence saved!");
}

function renderHistory() {
  const list  = $("history-list");
  const empty = $("history-empty");
  if (!sentenceHistory.length) {
    list.innerHTML = "";
    list.appendChild(empty);
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  list.innerHTML = "";
  sentenceHistory.forEach(item => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.title = "Click to load into builder";
    div.innerHTML =
      '<span class="history-item-text">' + esc(item.text) + '</span>' +
      '<span class="history-item-time">' + item.time + '</span>' +
      '<button class="history-speak-btn" title="Read aloud" onclick="speakText(\'' + esc(item.text) + '\');event.stopPropagation();">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>' +
      '</button>';
    div.addEventListener("click", () => {
      wordBuffer = item.text;
      updateWordDisplay();
      showToast("Loaded into builder.");
    });
    list.appendChild(div);
  });
}

function clearHistory() {
  sentenceHistory = [];
  renderHistory();
}

// ────────────────────────────────────────────
//  SPEECH
// ────────────────────────────────────────────
function speakWords() {
  const text = wordBuffer.trim();
  if (!text) { showToast("Nothing to speak."); return; }
  speakText(text);
}

function speakText(text) {
  if (!("speechSynthesis" in window)) { showToast("Speech not supported."); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.88; u.pitch = 1; u.volume = 1;
  window.speechSynthesis.speak(u);
  showToast('Speaking: "' + text.slice(0, 24) + (text.length > 24 ? "…" : "") + '"');
}

// ────────────────────────────────────────────
//  COPY
// ────────────────────────────────────────────
async function copyWords() {
  const text = wordBuffer.trim();
  if (!text) { showToast("Nothing to copy."); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied to clipboard!");
  } catch {
    showToast("Copy failed — select & copy manually.");
  }
}

// ────────────────────────────────────────────
//  HELPERS
// ────────────────────────────────────────────
function highlightGrid(letter) {
  if (lastGridLetter === letter) return;
  if (lastGridLetter) {
    const prev = $("tile-" + lastGridLetter);
    if (prev) prev.classList.remove("active");
  }
  const el = $("tile-" + letter);
  if (el) el.classList.add("active");
  lastGridLetter = letter;
}

function clearGrid() {
  if (lastGridLetter) {
    const el = $("tile-" + lastGridLetter);
    if (el) el.classList.remove("active");
    lastGridLetter = null;
  }
}

function resetDetection() {
  currentLetter = null;
  $("letter-char").textContent = "?";
  $("letter-char").classList.remove("confident");
  $("letter-ring").classList.remove("confident");
  $("letter-sub").textContent  = "Waiting…";
  $("meter-fill").style.width  = "0%";
  $("meter-pct").textContent   = "—";
  $("meter-fill").classList.remove("confident");
  $("meter-pct").classList.remove("confident");
  clearGrid();
}

function setPill(pillId, textId, label, modelOnline = false, camOn = false) {
  const pill = $(pillId);
  pill.className = "pill";
  if (modelOnline) pill.classList.add("online");
  if (camOn)       pill.classList.add("cam-on");
  $(textId).textContent = label;
}

function setHint(msg) {
  const el = $("cam-hint");
  if (el) el.textContent = msg;
}

let toastTimer = null;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
}

function esc(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}