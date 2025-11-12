// assets/app.js
import { API_BASE } from "./config.js";
import { makeSystem } from "./prompt.js";

/* ============ Sélecteurs UI ============ */
const chatEl     = document.getElementById("chat");
const inputEl    = document.getElementById("input");
const sendBtn    = document.getElementById("send");
const saveBtn    = document.getElementById("save");
const resetBtn   = document.getElementById("reset");
const personaSel = document.getElementById("persona");
const worldTa    = document.getElementById("world");
const modelSel   = document.getElementById("model");
const ttsChk     = document.getElementById("tts");

// Optionnels (identité classe/élève)
const classInput = document.getElementById("classId");
const userInput  = document.getElementById("userId");

/* ============ État ============ */
let PERSONAS = {};          // { id: { name, bio, piperVoice, ... } }
let DEFAULT_WORLD = {};
let history = [];
let sessionId = crypto.randomUUID();
let MEMORY = { summary: "", notes: [] };

/* ============ Identité ============ */
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

/* ============ TTS local Piper (Mintplex par défaut) ============ */
/** IMPORTANT : @mintplex-labs/piper-tts-web ne gère PAS ‘speaker’ (multi-locuteur). 
 *  On choisit donc seulement ‘voiceId’. Pour un ‘speaker’ chiffré, voir bloc “Poket-Jony” plus bas.
 *  Docs Mintplex : predict({ text, voiceId }).  */
const USE_PIPER_MINTPLEX = true;    // true par défaut
const USE_PIPER_POKET    = false;   // passe à true si tu veux tester l’autre lib (voir bloc plus bas)

let ttsMint = null;                  // espace de la lib Mintplex
let ttsPoket = null;                 // espace de la lib Poket-Jony
let poketEngine = null;              // instance PiperWebEngine (Poket-Jony)
let TTS_VOICE_CACHE = {};            // { personaId : voiceId }

async function ensureMintplexLoaded() {
  if (!USE_PIPER_MINTPLEX) return false;
  if (ttsMint) return true;
  try {
    // chemin ESM CDN fonctionnel (la version minifiée "index.min.js" n'existe pas sur ce paquet)
    ttsMint = await import("https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js");
  } catch {
    ttsMint = await import("https://esm.sh/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js");
  }
  return true;
}

// (Option) Lib Poket-Jony qui accepte generate(text, voice, speaker) — nécessite souvent des assets supplémentaires
async function ensurePoketLoaded() {
  if (!USE_PIPER_POKET) return false;
  if (ttsPoket) return true;
  try {
    ttsPoket = await import("https://cdn.jsdelivr.net/npm/piper-tts-web@1.1.2/dist/index.min.js");
  } catch {
    ttsPoket = await import("https://esm.run/piper-tts-web@1.1.2");
  }
  return true;
}

async function pickVoiceForPersona(pid) {
  const persona = PERSONAS[pid];
  // Persona peut fournir piperVoice (ex: "fr_FR-siwis-medium"). Sinon on prend la 1re voix FR dispo.
  if (USE_PIPER_MINTPLEX) {
    await ensureMintplexLoaded();
    const all = await ttsMint.voices();
    if (persona?.piperVoice && all[persona.piperVoice]) return persona.piperVoice;
    const entry = Object.entries(all).find(([_, meta]) => (meta?.language || "").toLowerCase().startsWith("fr"));
    return entry ? entry[0] : Object.keys(all)[0];
  }
  // Si tu passes à la lib Poket-Jony, ‘voice’ est une string (ex: "fr_FR-siwis-medium")
  return persona?.piperVoice || "fr_FR-siwis-medium";
}

/* —— Balises non-verbales → garder en logs, nettoyer pour affichage/lecture —— */
function stripNvForDisplay(text) {
  // enlève <nv .../> et <nv>...</nv> pour l’affichage
  return String(text)
    .replace(/<nv\b[^>]*\/>/gi, " ")
    .replace(/<nv\b[^>]*>([\s\S]*?)<\/nv>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Préparer TTS : remplacer balises nv par des pauses, stocker des SFX éventuels
const NV_SFX = {
  grogne: "./assets/sfx/grunt.wav",
  soupire: "./assets/sfx/sigh.wav",
  rire:   "./assets/sfx/chuckle.wav",
  hmm:    "./assets/sfx/hmm.wav"
};

function parseNonVerbalsForTTS(text) {
  let s = String(text);
  const sfx = [];

  s = s.replace(/<nv\b([^>]*?)\/>/gi, (_, attrs) => {
    const t = /type\s*=\s*["']?([\w-]+)["']?/i.exec(attrs)?.[1]?.toLowerCase();
    if (t) sfx.push(t);
    return " … ";
  });

  s = s.replace(/<nv\b[^>]*>([\s\S]*?)<\/nv>/gi, (_, inner) => {
    const t = (inner || "").trim().toLowerCase();
    if (t) sfx.push(t);
    return " … ";
  });

  s = s.replace(/\b[hH]mpf+[\.\!\?]*/g, " … ");
  s = s.replace(/\((?:grogne|soupire|soupir|rire|hum|hmm)\)/gi, " … ");
  s = s.replace(/\*[^*]{0,30}\*/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  if (!s) s = "…";
  return { clean: s, sfx };
}

function playSfxList(sfxList) {
  for (const key of sfxList) {
    const url = NV_SFX[key];
    if (!url) continue;
    try {
      const a = new Audio(url);
      a.volume = 0.6;
      a.play();
    } catch {}
  }
}

async function speakWithPiper(text) {
  if (!ttsChk?.checked) return;
  const { clean, sfx } = parseNonVerbalsForTTS(text);
  const pid = personaSel.value || Object.keys(PERSONAS)[0];
  const persona = PERSONAS[pid] || {};

  // (A) Tentative Poket-Jony — à activer quand tu veux le vrai “speaker”
  if (USE_PIPER_POKET) {
    try {
      await ensurePoketLoaded();
      if (!poketEngine && ttsPoket?.PiperWebEngine) {
        poketEngine = new ttsPoket.PiperWebEngine();
      }
      if (poketEngine) {
        const voice = await pickVoiceForPersona(pid);
        const speaker = Number.isFinite(persona?.piperSpeaker) ? Number(persona.piperSpeaker) : 0;
        const resp = await poketEngine.generate(clean, voice, speaker);
        // resp peut varier selon la build; on tente plusieurs cas
        let blob = null;
        if (resp?.wav instanceof Blob) blob = resp.wav;
        else if (resp instanceof Blob) blob = resp;
        if (blob) {
          const audio = new Audio(URL.createObjectURL(blob));
          audio.onplay = () => playSfxList(sfx);
          await audio.play();
          return;
        }
      }
    } catch (e) {
      console.warn("Poket-Jony Piper TTS a échoué, on essaie Mintplex :", e);
    }
  }

  // (B) Mintplex (sans speaker)
  try {
    await ensureMintplexLoaded();
    const voiceId = TTS_VOICE_CACHE[pid] || (TTS_VOICE_CACHE[pid] = await pickVoiceForPersona(pid));
    if (Number.isFinite(persona?.piperSpeaker)) {
      console.info(`[TTS] Le 'speaker' ${persona.piperSpeaker} est ignoré par @mintplex-labs/piper-tts-web (lib sans paramètre speaker).`);
    }
    await ttsMint.download(voiceId, (p) => updateBootProgress(null, Math.round(p*100)));
    const wav = await ttsMint.predict({ text: clean, voiceId });
    const audio = new Audio(URL.createObjectURL(wav));
    audio.onplay = () => playSfxList(sfx);
    await audio.play();
  } catch (e) {
    console.warn("Piper TTS (Mintplex) erreur, fallback WebSpeech:", e);
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "fr-FR";
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      playSfxList(sfx);
    }
  }
}

/* ============ Overlay boot (messages immersifs) ============ */
const bootEl = document.getElementById("boot");
const bootMsgEl = document.getElementById("boot-msg");
const bootBarEl = document.getElementById("boot-bar");

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

/* ============ Modèles affichés ============ */
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
    // affichage "Prénom — Groupe" si présent
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

  // Mémoire R2 (si route absente → ignore)
  try { await loadMemory(); } catch {}

  // Préchargement des voix (Mintplex)
  try {
    if (USE_PIPER_MINTPLEX) {
      await ensureMintplexLoaded();
      const ids = Object.keys(PERSONAS);
      for (let i = 0; i < ids.length; i++) {
        const pid = ids[i];
        const v = await pickVoiceForPersona(pid);
        TTS_VOICE_CACHE[pid] = v;
        updateBootProgress(`(${i+1}/${ids.length}) ${PERSONAS[pid].name || pid} s’installe…`, Math.round(((i+1)/ids.length)*100));
        try { await ttsMint.download(v); } catch {}
      }
    }
  } catch {}

  hideBoot();
  inputEl?.focus();
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

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
  div.className = "msg " + (role === "user" ? "user" : "bot");
  const display = role === "assistant" ? stripNvForDisplay(text) : text;
  div.textContent = display;
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
    // repli si modèle non dispo
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
  saveMemory(); // async
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
