// assets/app.js
import { API_BASE } from "./config.js";
import { makeSystem } from "./prompt.js";

/* ============================================================
   UI ELEMENTS
   ============================================================ */
const chatEl     = document.getElementById("chat");
const inputEl    = document.getElementById("input");
const sendBtn    = document.getElementById("send");
const saveBtn    = document.getElementById("save");
const resetBtn   = document.getElementById("reset");
const personaSel = document.getElementById("persona");
const worldTa    = document.getElementById("world");
const modelSel   = document.getElementById("model");
const ttsChk     = document.getElementById("tts");

// Optionnel : si tu ajoutes plus tard <input id="classId"> et <input id="userId">
// on les détecte, sinon on prend des valeurs par défaut.
const classInput = document.getElementById("classId");
const userInput  = document.getElementById("userId");

/* ============================================================
   ETAT APP
   ============================================================ */
let PERSONAS = {};
let DEFAULT_WORLD = {};
let history = [];                        // [{role:"user"|"assistant", content:string}]
let sessionId = crypto.randomUUID();     // un identifiant par “séance”
let MEMORY = { summary: "", notes: [] }; // mémoire légère côté élève

// Identité classe/élève (persistée localement)
function getClassId() {
  return (classInput?.value?.trim())
      || localStorage.getItem("bt_class")
      || "demo-classe";
}
function getUserId() {
  return (userInput?.value?.trim())
      || localStorage.getItem("bt_user")
      || "eleve-anonyme";
}
function persistIds() {
  const cid = classInput?.value?.trim();
  const uid = userInput?.value?.trim();
  if (cid) localStorage.setItem("bt_class", cid);
  if (uid) localStorage.setItem("bt_user",  uid);
}

/* ============================================================
   TTS OPTION B : PIPER DANS LE NAVIGATEUR (WASM via ONNX)
   - aucune API externe payante par génération
   - modèles mis en cache dans l’OPFS du navigateur
   Sources:
     - Piper TTS Web (lib)  :contentReference[oaicite:0]{index=0}
     - ONNX Runtime Web     :contentReference[oaicite:1]{index=1}
   ============================================================ */
const USE_PIPER = true; // ON par défaut
let ttsLib = null;      // module @mintplex-labs/piper-tts-web
let ttsReady = false;
let TTS_VOICE_CACHE = {}; // { personaId : voiceId }

async function ensurePiperLoaded() {
  if (!USE_PIPER) return false;
  if (ttsLib) return true;

  // Import ESM via CDN (aucun bundler requis sur GitHub Pages)
  // La lib charge ORT Web en interne et met les modèles en cache (OPFS).
  // Remarque : 1er chargement d’un modèle = téléchargement (quelques dizaines de Mo).
  ttsLib = await import("https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web/dist/index.min.js");
  // Pour accélérer : tu peux pré-télécharger une voix FR avec ttsLib.download(voiceId, cb)
  ttsReady = true;
  return true;
}

async function getFrenchVoiceIdForPersona(personaId, prefer) {
  // 1) persona peut préciser une voix Piper (ex: "fr_FR-mls-medium")
  const persona = PERSONAS[personaId];
  if (persona?.piperVoice) return persona.piperVoice;

  // 2) sinon on choisit la 1re voix française disponible
  const voices = await ttsLib.voices(); // renvoie la liste des voix supportées
  // Heuristique: prendre celle qui commence par "fr_" ou contient "fr"
  const frEntry = Object.entries(voices).find(([key, meta]) =>
    key.toLowerCase().startsWith("fr_") ||
    (meta?.language || "").toLowerCase().startsWith("fr")
  );
  if (frEntry) return frEntry[0];

  // 3) fallback global (s’il n’y a pas de voix FR dans la lib utilisée)
  const any = Object.keys(voices)[0];
  return any;
}

async function speakWithPiper(text) {
  if (!ttsChk?.checked) return;
  try {
    if (!await ensurePiperLoaded()) return;
    const pid = personaSel.value || Object.keys(PERSONAS)[0];
    const cached = TTS_VOICE_CACHE[pid];
    const voiceId = cached || (TTS_VOICE_CACHE[pid] = await getFrenchVoiceIdForPersona(pid));
    // 1er usage : télécharge et met en cache le modèle (OPFS)
    await ttsLib.download(voiceId);
    // Synthèse → Blob WAV
    const wavBlob = await ttsLib.predict({ text, voiceId });
    const audio = new Audio();
    audio.src = URL.createObjectURL(wavBlob);
    audio.play();
  } catch (e) {
    console.warn("Piper TTS error, fallback WebSpeech:", e);
    // Fallback gratuit: Web Speech (voix système)  :contentReference[oaicite:2]{index=2}
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "fr-FR";
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    }
  }
}

/* ============================================================
   CHARGEMENT DES DONNÉES (personas & monde)
   - Les options de la liste affichent "Prénom — Groupe"
   - Modèles : 5 entrées (4o-mini, 4o, 5, 4.1, 3.5-turbo)
   ============================================================ */
const MODEL_LIST = [
  { id: "gpt-4o-mini", label: "gpt-4o-mini (recommandé)" },
  { id: "gpt-4o",      label: "gpt-4o" },
  { id: "gpt-5",       label: "gpt-5 (si accès)" },
  { id: "gpt-4.1",     label: "gpt-4.1" },
  { id: "gpt-3.5-turbo", label: "gpt-3.5-turbo (ancien)" }
];

async function loadData() {
  // PERSONAS
  const list = await fetch("./data/personas.json").then(r => r.json());
  PERSONAS = Object.fromEntries(list.map(x => [x.id, x]));
  personaSel.innerHTML = list.map(x => {
    const label = x.displayName || (x.firstName && x.group ? `${x.firstName} — ${x.group}` : x.name || x.id);
    return `<option value="${x.id}">${escapeHtml(label)}</option>`;
  }).join("");

  // MODELS
  modelSel.innerHTML = MODEL_LIST.map(m => `<option value="${m.id}">${m.label}</option>`).join("");

  // WORLD
  DEFAULT_WORLD = await fetch("./data/world.json").then(r => r.json());
  worldTa.value = JSON.stringify(DEFAULT_WORLD, null, 2);

  // HISTORIQUE (local, pour l’onglet)
  try {
    const prev = JSON.parse(localStorage.getItem("bt_demo_history") || "[]");
    if (prev.length) {
      history = prev;
      for (const m of prev) addMsg(m.role, m.content);
    }
  } catch {}

  // MÉMOIRE : on charge la mémoire R2 de la classe/élève si existante
  await loadMemory();
  inputEl?.focus();
}

function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

/* ============================================================
   MÉMOIRE PAR CLASSE/ÉLÈVE (simple et robuste)
   - GET /api/memory?classId=...&userId=...
   - POST /api/memory { classId, userId, personaId, memory }
   (voir plus bas le petit ajout Worker)
   ============================================================ */
async function loadMemory() {
  try {
    const cid = getClassId(); const uid = getUserId();
    const url = `${API_BASE}/memory?classId=${encodeURIComponent(cid)}&userId=${encodeURIComponent(uid)}`;
    const r = await fetch(url);
    if (r.ok) {
      MEMORY = await r.json();
    } else {
      MEMORY = { summary: "", notes: [] };
    }
  } catch {
    MEMORY = { summary: "", notes: [] };
  }
}
async function saveMemory() {
  const cid = getClassId(); const uid = getUserId();
  const pid = personaSel.value;
  await fetch(`${API_BASE}/memory`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ classId: cid, userId: uid, personaId: pid, memory: MEMORY })
  });
}

// Mise à jour très légère de la mémoire après chaque échange
function updateMemory(userText, botText) {
  // notes "à plat", 1 ligne par prise de parole, max 30
  const now = new Date().toISOString();
  MEMORY.notes.push({ t: now, u: userText, a: botText });
  if (MEMORY.notes.length > 30) MEMORY.notes.splice(0, MEMORY.notes.length - 30);

  // mini résumé naïf (sans coût d’API) : on garde la dernière ligne “but / point clé”
  const last = botText.split(/[.!?]/).find(s => s.trim().length > 8) || botText;
  MEMORY.summary = (MEMORY.summary ? MEMORY.summary + " " : "") + last.trim();
  if (MEMORY.summary.length > 600) MEMORY.summary = MEMORY.summary.slice(-600); // borne simple
}

/* ============================================================
   AFFICHAGE & ENVOI
   ============================================================ */
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "card msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  if (role === "assistant") {
    // TTS Piper (ou fallback WebSpeech)
    speakWithPiper(text);
  }
  localStorage.setItem("bt_demo_history", JSON.stringify(history));
}

personaSel?.addEventListener("change", () => {
  // immersion : reset conversation si on change de persona
  resetConversation();
});

function resetConversation() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  history = [];
  chatEl.innerHTML = "";
  localStorage.removeItem("bt_demo_history");
  sessionId = crypto.randomUUID();
  worldTa.value = JSON.stringify(DEFAULT_WORLD, null, 2);
  inputEl.value = "";
  inputEl.focus();
}

async function sendMsg() {
  persistIds();

  const content = inputEl.value.trim();
  if (!content) return;

  history.push({ role: "user", content });
  addMsg("user", content);
  inputEl.value = "";

  const pid = personaSel.value;
  const persona = PERSONAS[pid] || PERSONAS[Object.keys(PERSONAS)[0]];
  let world;
  try { world = JSON.parse(worldTa.value || "{}"); } catch { world = DEFAULT_WORLD; }

  // On injecte aussi la MEMORY côté system pour “connaître la partie”
  const system = makeSystem(persona, { ...world, memory: MEMORY });
  const chosenModel = modelSel?.value || "gpt-4o-mini";

  let reply = "(pas de réponse)";
  try {
    const r = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, system, model: chosenModel })
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || "API error");
    reply = data.reply || reply;
  } catch (e) {
    // Fallback si le modèle choisi n’est pas accessible → on retente avec 4o-mini
    console.warn("Chat error, retry on gpt-4o-mini:", e);
    try {
      const r2 = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, system, model: "gpt-4o-mini" })
      });
      const d2 = await r2.json();
      reply = d2.reply || reply;
    } catch { /* on garde le reply par défaut */ }
  }

  history.push({ role:"assistant", content: reply });
  addMsg("assistant", reply);

  // mémoire (locale & R2)
  updateMemory(content, reply);
  saveMemory(); // asynchrone, pas bloquant
}

async function saveTranscript() {
  // NDJSON (1 ligne = 1 message)
  const transcript = history.map(m => JSON.stringify({ ts: Date.now(), ...m })).join("\n");
  await fetch(`${API_BASE}/save`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      sessionId,
      transcript,
      contentType:"application/x-ndjson",
      classId: getClassId(),
      userId:  getUserId()
    })
  });
  alert("Session enregistrée (R2).");
}

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  // Optionnel : précharge Piper si la case est cochée
  if (ttsChk?.checked) ensurePiperLoaded();

  // Fix visuels (certains thèmes rendent les <option> illisibles)
  try {
    // Les options ne sont pas toujours stylables, mais on force les selects lisibles:
    if (modelSel)   modelSel.style.color = "inherit";
    if (personaSel) personaSel.style.color = "inherit";
  } catch {}
});
sendBtn.onclick  = sendMsg;
saveBtn.onclick  = saveTranscript;
resetBtn && (resetBtn.onclick = resetConversation);

// Entrée = envoyer
inputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
