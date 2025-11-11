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

/* Optionnel si tu ajoutes plus tard : <input id="classId"> <input id="userId"> */
const classInput = document.getElementById("classId");
const userInput  = document.getElementById("userId");

/* ============ Etat ============ */
let PERSONAS = {};
let DEFAULT_WORLD = {};
let history = [];                         // [{role, content}]
let sessionId = crypto.randomUUID();
let MEMORY = { summary: "", notes: [] };  // mémoire locale (résumé+notes)

/* ============ Identité classe/élève ============ */
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

/* ============ TTS Piper (WASM) + préchargement ============ */
// Lib
const USE_PIPER = true;      // activer/désactiver Piper
let ttsLib = null;           // module @mintplex-labs/piper-tts-web
let TTS_VOICE_CACHE = {};    // { personaId : voiceId }

async function ensurePiperLoaded() {
  if (!USE_PIPER) return false;
  if (ttsLib) return true;
  ttsLib = await import("https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web/dist/index.min.js");
  return true;
}

async function listVoices() {
  await ensurePiperLoaded();
  return await ttsLib.voices(); // { voiceId: {language, ...}, ...}
}

async function pickVoiceForPersona(pid) {
  // persona.piperVoice prioritaire, sinon première FR disponible
  const persona = PERSONAS[pid];
  await ensurePiperLoaded();
  const all = await ttsLib.voices();
  if (persona?.piperVoice && all[persona.piperVoice]) return persona.piperVoice;
  const entry = Object.entries(all).find(([id, meta]) =>
    (meta?.language || "").toLowerCase().startsWith("fr")
  );
  return entry ? entry[0] : Object.keys(all)[0];
}

async function speakWithPiper(text) {
  if (!ttsChk?.checked) return;
  try {
    await ensurePiperLoaded();
    const pid = personaSel.value || Object.keys(PERSONAS)[0];
    const voiceId = TTS_VOICE_CACHE[pid] || (TTS_VOICE_CACHE[pid] = await pickVoiceForPersona(pid));
    // Télécharge en cache si nécessaire
    await ttsLib.download(voiceId, (p) => updateBootProgress(`Téléchargement voix ${voiceId}… ${Math.round(p*100)}%`));
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

/* ============ Préchargement : overlay + progression ============ */
const bootEl = document.getElementById("boot");        // <div id="boot"><div id="boot-msg"></div><div id="boot-bar"></div></div>
const bootMsgEl = document.getElementById("boot-msg");
const bootBarEl = document.getElementById("boot-bar");

function showBoot(msg) {
  if (!bootEl) return;
  bootEl.style.display = "grid";
  updateBootProgress(msg || "Préparation de la salle…");
}
function hideBoot() { if (bootEl) bootEl.style.display = "none"; }
function updateBootProgress(msg, pct) {
  if (bootMsgEl && msg) bootMsgEl.textContent = msg;
  if (bootBarEl && typeof pct === "number") bootBarEl.style.setProperty("--p", `${pct}%`);
}

async function preloadVoices() {
  if (!USE_PIPER) return;
  await ensurePiperLoaded();
  const personaIds = Object.keys(PERSONAS);
  for (let i = 0; i < personaIds.length; i++) {
    const pid = personaIds[i];
    const v = await pickVoiceForPersona(pid);
    TTS_VOICE_CACHE[pid] = v;
    updateBootProgress(`(${i+1}/${personaIds.length}) ${PERSONAS[pid].name} installe les chaises…`, Math.round(((i+1)/personaIds.length)*100));
    try { await ttsLib.download(v); } catch {}
  }
}

/* ============ Modèles (avec fallback) ============ */
const MODEL_LIST = [
  { id: "gpt-4o-mini",   label: "gpt-4o-mini (recommandé)" },
  { id: "gpt-4o",        label: "gpt-4o" },
  { id: "gpt-4.1",       label: "gpt-4.1" },      // dispo selon compte
  { id: "gpt-5",         label: "gpt-5 (si accès)" }, // peut ne pas être dispo
  { id: "gpt-3.5-turbo", label: "gpt-3.5-turbo (ancien)" }
];

/* ============ Chargement données ============ */
async function loadData() {
  showBoot("Le forum s’éveille…");

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

  // HISTORIQUE (onglet)
  try {
    const prev = JSON.parse(localStorage.getItem("bt_demo_history") || "[]");
    if (prev.length) {
      history = prev;
      for (const m of prev) addMsg(m.role, m.content);
    }
  } catch {}

  // MÉMOIRE (R2)
  await loadMemory();

  // Pré-charger voix (barre + messages immersifs)
  updateBootProgress("Les chaises se placent…", 10);
  await preloadVoices();
  hideBoot();

  inputEl?.focus();
}

function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

/* ============ Mémoire classe/élève simple (R2) ============ */
async function loadMemory() {
  try {
    const cid = getClassId(); const uid = getUserId();
    const url = `${API_BASE}/memory?classId=${encodeURIComponent(cid)}&userId=${encodeURIComponent(uid)}`;
    const r = await fetch(url);
    MEMORY = r.ok ? await r.json() : { summary:"", notes:[] };
  } catch { MEMORY = { summary:"", notes:[] }; }
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

/* ============ Affichage & actions ============ */
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "card msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  if (role === "assistant") {
    speakWithPiper(text);
  }
  localStorage.setItem("bt_demo_history", JSON.stringify(history));
}

personaSel?.addEventListener("change", () => resetConversation());

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

  // injecte la mémoire et les “farewells” dans le contexte
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
    // repli sur 4o-mini si le modèle n’est pas accessible
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
  saveMemory();
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
