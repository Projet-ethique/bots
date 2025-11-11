// assets/app.js
import { API_BASE } from "./config.js";
import { makeSystem } from "./prompt.js";

/* ============ UI ============ */
const chatEl     = document.getElementById("chat");
const inputEl    = document.getElementById("input");
const sendBtn    = document.getElementById("send");
const saveBtn    = document.getElementById("save");
const resetBtn   = document.getElementById("reset");
const personaSel = document.getElementById("persona");
const worldTa    = document.getElementById("world");
const modelSel   = document.getElementById("model");
const ttsChk     = document.getElementById("tts");

// Optionnels pour plus tard (login)
const classInput = document.getElementById("classId");
const userInput  = document.getElementById("userId");

/* ============ Etat ============ */
let PERSONAS = {};
let DEFAULT_WORLD = {};
let history = [];
let sessionId = crypto.randomUUID();
let MEMORY = { summary: "", notes: [] };

/* ============ Identité classe/élève ============ */
function getClassId() {
  return (classInput?.value?.trim()) || localStorage.getItem("bt_class") || "demo-classe";
}
function getUserId() {
  return (userInput?.value?.trim()) || localStorage.getItem("bt_user") || "eleve-anonyme";
}
function persistIds() {
  const cid = classInput?.value?.trim();
  const uid = userInput?.value?.trim();
  if (cid) localStorage.setItem("bt_class", cid);
  if (uid) localStorage.setItem("bt_user",  uid);
}

/* ============ TTS Piper (WASM) + fallback WebSpeech ============ */
const USE_PIPER = true;
let ttsLib = null;
let TTS_VOICE_CACHE = {}; // { personaId : voiceId }

async function ensurePiperLoaded() {
  if (!USE_PIPER) return false;
  if (ttsLib) return true;
  try {
    // Chemin correct (le package ne fournit pas index.min.js)
    ttsLib = await import("https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js");
  } catch {
    // Fallback CDN ESM
    ttsLib = await import("https://esm.sh/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js");
  }
  return true;
}
async function pickVoiceForPersona(pid) {
  await ensurePiperLoaded();
  const persona = PERSONAS[pid];
  const all = await ttsLib.voices();
  if (persona?.piperVoice && all[persona.piperVoice]) return persona.piperVoice;
  const entry = Object.entries(all).find(([id, meta]) => (meta?.language || "").toLowerCase().startsWith("fr"));
  return entry ? entry[0] : Object.keys(all)[0];
}
async function speakWithPiper(text) {
  if (!ttsChk?.checked) return;
  try {
    await ensurePiperLoaded();
    const pid = personaSel.value || Object.keys(PERSONAS)[0];
    const voiceId = TTS_VOICE_CACHE[pid] || (TTS_VOICE_CACHE[pid] = await pickVoiceForPersona(pid));
    await ttsLib.download(voiceId, (p) => updateBootProgress(null, Math.round(p*100)));
    const wav = await ttsLib.predict({ text, voiceId });
    const audio = new Audio(URL.createObjectURL(wav));
    await audio.play();
  } catch (e) {
    console.warn("Piper TTS error, fallback WebSpeech:", e);
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "fr-FR";
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    }
  }
}

/* ============ Overlay boot + messages tournants ============ */
const bootEl = document.getElementById("boot");
const bootMsgEl = document.getElementById("boot-msg");
const bootBarEl = document.getElementById("boot-bar");

// Messages immersifs (rotation)
const BOOT_LINES = [
  "La salle s’ouvre au Forum de la Côte-Nord…",
  "Placement des chaises…",
  "Préparation du buffet…",
  "Vérification des micros…",
  "Les cartes du littoral sont accrochées…",
  "Gaspard descend du bus…",
  "Naé salue les anciens…",
  "Mika vérifie les outils…",
  "Lia repère les couloirs d’oiseaux…",
  "Téo range les filets au port…",
  "Rafi poste l’annonce du débat…"
];
let bootTimer = null, bootIndex = 0;

function showBoot(msg) {
  if (!bootEl) return;
  bootEl.style.display = "grid";
  updateBootProgress(msg || BOOT_LINES[0], 5);
  bootIndex = 0;
  bootTimer = setInterval(() => {
    bootIndex = (bootIndex + 1) % BOOT_LINES.length;
    updateBootProgress(BOOT_LINES[bootIndex]);
  }, 1200);
}
function hideBoot() {
  if (!bootEl) return;
  clearInterval(bootTimer); bootTimer = null;
  bootEl.style.display = "none";
}
function updateBootProgress(msg, pct) {
  if (bootMsgEl && msg) bootMsgEl.textContent = msg;
  if (bootBarEl && typeof pct === "number") bootBarEl.style.setProperty("--p", `${pct}%`);
}

/* ============ Modèles (avec fallback si indisponible) ============ */
const MODEL_LIST = [
  { id: "gpt-4o-mini",   label: "gpt-4o-mini (recommandé)" },
  { id: "gpt-4o",        label: "gpt-4o" },
  { id: "gpt-4.1",       label: "gpt-4.1" },
  { id: "gpt-5",         label: "gpt-5 (si accès)" },
  { id: "gpt-3.5-turbo", label: "gpt-3.5-turbo (ancien)" }
];

/* ============ Chargement données ============ */
async function loadData() {
  showBoot("Le forum s’éveille…");

  // Personas
  const list = await fetch("./data/personas.json").then(r => r.json());
  PERSONAS = Object.fromEntries(list.map(x => [x.id, x]));
  personaSel.innerHTML = list.map(x => {
    const label = x.displayName || (x.firstName && x.group ? `${x.firstName} — ${x.group}` : x.name || x.id);
    return `<option value="${x.id}">${escapeHtml(label)}</option>`;
  }).join("");

  // Modèles
  modelSel.innerHTML = MODEL_LIST.map(m => `<option value="${m.id}">${m.label}</option>`).join("");

  // Monde
  DEFAULT_WORLD = await fetch("./data/world.json").then(r => r.json());
  worldTa.value = JSON.stringify(DEFAULT_WORLD, null, 2);

  // Historique local
  try {
    const prev = JSON.parse(localStorage.getItem("bt_demo_history") || "[]");
    if (prev.length) {
      history = prev;
      for (const m of prev) addMsg(m.role, m.content);
    }
  } catch {}

  // Mémoire R2 (si la route n’est pas encore en place, on ignore l’erreur)
  try {
    await loadMemory();
  } catch {}

  // Pré-chargement des voix
  try {
    await preloadVoices();
  } catch {}

  hideBoot();
  inputEl?.focus();
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

async function preloadVoices() {
  if (!USE_PIPER) return;
  await ensurePiperLoaded();
  const ids = Object.keys(PERSONAS);
  for (let i = 0; i < ids.length; i++) {
    const pid = ids[i];
    const v = await pickVoiceForPersona(pid);
    TTS_VOICE_CACHE[pid] = v;
    updateBootProgress(`(${i+1}/${ids.length}) ${PERSONAS[pid].name} s'installe…`, Math.round(((i+1)/ids.length)*100));
    try { await ttsLib.download(v); } catch {}
  }
}

/* ============ Mémoire classe/élève (R2) ============ */
async function loadMemory() {
  const cid = getClassId(); const uid = getUserId();
  const url = `${API_BASE}/memory?classId=${encodeURIComponent(cid)}&userId=${encodeURIComponent(uid)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("memory endpoint not ready");
  MEMORY = await r.json();
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
function updateMemory(userText, botText) {
  const now = new Date().toISOString();
  MEMORY.notes.push({ t: now, u: userText, a: botText });
  if (MEMORY.notes.length > 30) MEMORY.notes.splice(0, MEMORY.notes.length - 30);
  const last = botText.split(/[.!?]/).find(s => s.trim().length > 8) || botText;
  MEMORY.summary = (MEMORY.summary ? MEMORY.summary + " " : "") + last.trim();
  if (MEMORY.summary.length > 800) MEMORY.summary = MEMORY.summary.slice(-800);
}

/* ============ Chat UI ============ */
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "card msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  if (role === "assistant") speakWithPiper(text);
  localStorage.setItem("bt_demo_history", JSON.stringify(history));
}
personaSel?.addEventListener("change", () => resetConversation());

function resetConversation() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  history = []; chatEl.innerHTML = "";
  localStorage.removeItem("bt_demo_history");
  sessionId = crypto.randomUUID();
  worldTa.value = JSON.stringify(DEFAULT_WORLD, null, 2);
  inputEl.value = ""; inputEl.focus();
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
  let world; try { world = JSON.parse(worldTa.value || "{}"); } catch { world = DEFAULT_WORLD; }

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
  } catch {
    // repli auto si le modèle n’est pas accessible
    try {
      const r2 = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, system, model: "gpt-4o-mini" })
      });
      const d2 = await r2.json();
      reply = d2.reply || reply;
    } catch {}
  }

  history.push({ role:"assistant", content: reply });
  addMsg("assistant", reply);

  updateMemory(content, reply);
  saveMemory(); // asynchrone
}

async function saveTranscript() {
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

/* ============ Boot ============ */
document.addEventListener("DOMContentLoaded", loadData);
sendBtn.onclick  = sendMsg;
saveBtn.onclick  = saveTranscript;
resetBtn && (resetBtn.onclick = resetConversation);
inputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
