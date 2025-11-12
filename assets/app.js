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
const avatarEl   = document.getElementById("avatar"); // <img> dans la zone chat

// (optionnel) identifiants classe/élève
const classInput = document.getElementById("classId");
const userInput  = document.getElementById("userId");

/* ============ État ============ */
let PERSONAS = {};          // { id: { name, sfxProfile, piperVoice, speaker, ... } }
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

/* ============ Utils ============ */
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function normalizeVoiceId(id){
  if (!id) return null;
  return String(id).replace(/[\/\\]/g, "-").replace(/--+/g,"-");
}
function personaAvatarUrl(p) {
  if (p?.avatar) return p.avatar; // chemin explicite depuis personas.json
  // fallback: assets/avatars/<Prenom_ou_Nom>_profile.png
  const base = (p?.firstName || p?.name || "avatar")
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g,'_');
  return `./assets/avatars/${base}_profile.png`;
}
function updateAvatar() {
  const pid = personaSel.value;
  const p = PERSONAS[pid] || {};
  if (!avatarEl) return;
  const url = personaAvatarUrl(p);
  avatarEl.src = url;
  avatarEl.alt = (p.displayName || p.name || pid);
}

/* ============ TTS local Piper ============ */
/** Par défaut, on passe par Poket-Jony (gère 'speaker'),
 *  avec repli Mintplex (pas de 'speaker') puis WebSpeech.
 *  Poket-Jony: engine.generate(text, voice, speaker). :contentReference[oaicite:0]{index=0} */
const USE_PIPER_POKET    = true;   // speaker support
const USE_PIPER_MINTPLEX = false;  // repli simple

let ttsPoket = null;
let poketEngine = null;
let ttsMint = null;
let TTS_VOICE_CACHE = {}; // { personaId : voiceId }

/* --- Poket-Jony (self-host) --- */
async function ensurePoketLoaded() {
  if (!USE_PIPER_POKET) return false;
  if (ttsPoket) return true;
  // ⚠️ Ce chemin doit correspondre au nom réel dans ton repo
ttsPoket = await import('/assets/vendor/piper-tts-web/piper-tts-web.js');
  return true;
}

/* --- Mintplex (CDN) --- */
async function ensureMintplexLoaded() {
  if (!USE_PIPER_MINTPLEX) return false;
  if (ttsMint) return true;
  try {
    ttsMint = await import("https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js");
  } catch {
    ttsMint = await import("https://esm.sh/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js");
  }
  return true;
}

/* --- Choix de la voix --- */
async function pickVoiceForPersona(pid) {
  const persona = PERSONAS[pid] || {};
  if (USE_PIPER_MINTPLEX) {
    await ensureMintplexLoaded();
    const all = await ttsMint.voices();
    if (persona.piperVoice && all[normalizeVoiceId(persona.piperVoice)]) {
      return normalizeVoiceId(persona.piperVoice);
    }
    const entry = Object.entries(all).find(([_, meta]) => (meta?.language || "").toLowerCase().startsWith("fr"));
    return entry ? entry[0] : Object.keys(all)[0];
  }
  // Poket-Jony → string du modèle (ex: fr_FR-mls-medium, 125 speakers) :contentReference[oaicite:1]{index=1}
  return normalizeVoiceId(persona.piperVoice) || "fr_FR-mls-medium";
}

/* —— Balises non-verbales : garder en logs, nettoyer pour affichage —— */
function stripNvForDisplay(text) {
  return String(text)
    .replace(/<nv\b[^>]*\/>/gi, " ")
    .replace(/<nv\b[^>]*>([\s\S]*?)<\/nv>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ====== SFX non-verbaux (variantes homme/femme) ====== */
/* Place tes fichiers dans /assets/sfx/ :
   chuckle_man.wav, chuckle_woman.wav,
   grunt_male.wav,
   hmm_male.wav, hmm_woman.wav,
   sigh_male.wav, sigh_woman.wav
*/
const NV_SFX = {
  "default": {
    grunt:   "./assets/sfx/grunt_male.wav",
    sigh:    "./assets/sfx/sigh_male.wav",
    chuckle: "./assets/sfx/chuckle_man.wav",
    hmm:     "./assets/sfx/hmm_male.wav",
  },
  "male": {
    grunt:   "./assets/sfx/grunt_male.wav",
    sigh:    "./assets/sfx/sigh_male.wav",
    chuckle: "./assets/sfx/chuckle_man.wav",
    hmm:     "./assets/sfx/hmm_male.wav",
  },
  "female": {
    grunt:   "./assets/sfx/grunt_male.wav",         // fallback si pas de grunt_woman
    sigh:    "./assets/sfx/sigh_woman.wav",
    chuckle: "./assets/sfx/chuckle_woman.wav",
    hmm:     "./assets/sfx/hmm_woman.wav",
  }
};
// FR → clé SFX normalisée
const NV_MAP = {
  "grogne": "grunt", "grognement": "grunt",
  "soupire": "sigh", "soupir": "sigh",
  "rire": "chuckle", "riquette": "chuckle",
  "hmm": "hmm", "hum": "hmm"
};
const AUDIO_CACHE = {}; // { url : HTMLAudioElement }

function getSfxProfile() {
  const pid = personaSel.value;
  const p = PERSONAS[pid] || {};
  const g = (p.sfxProfile || p.gender || p.voiceGender || "").toString().toLowerCase();
  return (g === "female" || g === "femme" || g === "f") ? "female"
       : (g === "male"   || g === "homme" || g === "m") ? "male"
       : "default";
}
function pickSfxFile(profile, key) {
  const prof = NV_SFX[profile] || NV_SFX.default;
  return prof[key] || NV_SFX.default[key] || null;
}
function preloadSfxProfile(profile) {
  const tbl = NV_SFX[profile] || NV_SFX.default;
  for (const k in tbl) {
    const url = tbl[k];
    if (!AUDIO_CACHE[url]) {
      try {
        const a = new Audio(url);
        a.preload = "auto";
        AUDIO_CACHE[url] = a;
      } catch {}
    }
  }
}

// { clean, sfx: ["grunt","sigh",...] }
function parseNonVerbalsForTTS(text) {
  let s = String(text);
  const found = [];

  // <nv type="..."/>
  s = s.replace(/<nv\b([^>]*?)\/>/gi, (_, attrs) => {
    const t = /type\s*=\s*["']?([\w-]+)["']?/i.exec(attrs);
    const raw = (t && t[1] || "").toLowerCase();
    const key = NV_MAP[raw] || raw;
    if (key) found.push(key);
    return " … ";
  });

  // <nv>...</nv>
  s = s.replace(/<nv\b[^>]*>([\s\S]*?)<\/nv>/gi, (_, inner) => {
    const raw = (inner || "").trim().toLowerCase();
    const key = NV_MAP[raw] || raw;
    if (key) found.push(key);
    return " … ";
  });

  // nettoyage
  s = s.replace(/\b[hH]mpf+[\.\!\?]*/g, " … ");
  s = s.replace(/\((?:grogne|soupire|soupir|rire|hum|hmm)\)/gi, " … ");
  s = s.replace(/\*[^*]{0,30}\*/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  if (!s) s = "…";

  const sfx = found.map(x => (NV_MAP[x] || x))
                   .filter(x => ["grunt","sigh","chuckle","hmm"].includes(x));
  return { clean: s, sfx };
}
function playSfxList(sfxList, profile) {
  for (const key of sfxList) {
    const url = pickSfxFile(profile, key);
    if (!url) continue;
    try {
      const a = AUDIO_CACHE[url] || new Audio(url);
      a.currentTime = 0;
      a.volume = 0.6;
      a.play();
      AUDIO_CACHE[url] = a;
    } catch {}
  }
}

/* ====== Synthèse ====== */
async function speakWithPiper(text) {
  if (!ttsChk?.checked) return;
  const { clean, sfx } = parseNonVerbalsForTTS(text);
  const pid = personaSel.value || Object.keys(PERSONAS)[0];
  const persona = PERSONAS[pid] || {};
  const profile = getSfxProfile();

  // (A) Poket-Jony → support vrai du "speaker"
  if (USE_PIPER_POKET) {
    try {
      await ensurePoketLoaded();
      if (!poketEngine) {
        // Tente l'engine Worker+WebGPU+VoiceProvider, sinon simple
        if (ttsPoket?.PiperWebWorkerEngine && ttsPoket?.OnnxWebGPUWorkerRuntime && ttsPoket?.HuggingFaceVoiceProvider) {
          poketEngine = new ttsPoket.PiperWebWorkerEngine({
            onnxRuntime: new ttsPoket.OnnxWebGPUWorkerRuntime(),
            voiceProvider: new ttsPoket.HuggingFaceVoiceProvider()
          });
        } else if (ttsPoket?.PiperWebEngine) {
          poketEngine = new ttsPoket.PiperWebEngine();
        }
      }
      if (poketEngine) {
        const voice = await pickVoiceForPersona(pid);             // ex: "fr_FR-mls-medium"
        const spRaw = persona.speaker ?? persona.piperSpeaker;    // "5" ou 5
        const speaker = Number.isFinite(Number(spRaw)) ? Number(spRaw) : 0;
        const resp = await poketEngine.generate(clean, voice, speaker); // generate(text, voice, speaker) :contentReference[oaicite:2]{index=2}
        let blob = null;
        if (resp?.wav instanceof Blob) blob = resp.wav;
        else if (resp instanceof Blob) blob = resp;
        if (blob) {
          const audio = new Audio(URL.createObjectURL(blob));
          audio.onplay = () => playSfxList(sfx, profile);
          await audio.play();
          return;
        }
      }
    } catch (e) {
      console.warn("Poket-Jony a échoué; bascule sur Mintplex :", e);
    }
  }

  // (B) Mintplex (pas de "speaker")
  try {
    if (!USE_PIPER_MINTPLEX) throw new Error("Mintplex désactivé");
    await ensureMintplexLoaded();
    const voiceId = TTS_VOICE_CACHE[pid] || (TTS_VOICE_CACHE[pid] = await pickVoiceForPersona(pid));
    if (Number.isFinite(Number(persona.speaker ?? persona.piperSpeaker))) {
      console.info("[TTS] Note: Mintplex ne gère pas 'speaker', il est ignoré.");
    }
    await ttsMint.download(voiceId, (p) => updateBootProgress(null, Math.round(p*100)));
    const wav = await ttsMint.predict({ text: clean, voiceId });
    const audio = new Audio(URL.createObjectURL(wav));
    audio.onplay = () => playSfxList(sfx, profile);
    await audio.play();
  } catch (e) {
    // Fallback WebSpeech
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "fr-FR";
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      playSfxList(sfx, profile);
    } else {
      console.warn("Aucune synthèse disponible :", e);
    }
  }
}

/* ============ Overlay boot (messages immersifs) ============ */
const bootEl   = document.getElementById("boot");
const bootMsgEl= document.getElementById("boot-msg");
const bootBarEl= document.getElementById("boot-bar");

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
  "Bragi poste l’annonce du débat…"
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

/* ============ Chargement ============ */
async function loadData() {
  showBoot("Le forum s’éveille…");

  // Personas
  const list = await fetch("./data/personas.json").then(r => r.json());
  PERSONAS = Object.fromEntries(list.map(x => [x.id, x]));
  personaSel.innerHTML = list.map(x => {
    const label = x.displayName || (x.firstName && x.group ? `${x.firstName} — ${x.group}` : x.name || x.id);
    return `<option value="${x.id}">${escapeHtml(label)}</option>`;
  }).join("");
  updateAvatar();
  try { preloadSfxProfile(getSfxProfile()); } catch {}

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
// --- après avoir construit PERSONAS & personaSel ---
const personasEd = document.getElementById("personasEditor");
if (personasEd) {
  personasEd.value = JSON.stringify(Object.values(PERSONAS), null, 2);
  personasEd.addEventListener("change", () => {
    try {
      const arr = JSON.parse(personasEd.value || "[]");
      if (Array.isArray(arr) && arr.length) {
        PERSONAS = Object.fromEntries(arr.map(x => [x.id, x]));
        personaSel.innerHTML = arr.map(x => {
          const label = x.displayName || (x.firstName && x.group ? `${x.firstName} — ${x.group}` : x.name || x.id);
          return `<option value="${x.id}">${escapeHtml(label)}</option>`;
        }).join("");
        updateAvatar();
      }
    } catch (e) { console.warn("personasEditor JSON invalide:", e); }
  });
}

// --- remplir l’éditeur Prompt avec le texte de assets/prompt.js ---
const promptEd = document.getElementById("promptEditor");
if (promptEd) {
  try { promptEd.value = await fetch("./assets/prompt.js").then(r => r.text()); }
  catch {}
}

  // Mémoire R2 (si route absente → ignore)
  try { await loadMemory(); } catch {}

  hideBoot();
  inputEl?.focus();
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
  div.className = "msg " + (role === "user" ? "user" : "bot");
  const display = role === "assistant" ? stripNvForDisplay(text) : text;
  div.textContent = display;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  if (role === "assistant") speakWithPiper(text);
  localStorage.setItem("bt_demo_history", JSON.stringify(history));
}

personaSel?.addEventListener("change", () => {
  resetConversation();
  updateAvatar();
  try { preloadSfxProfile(getSfxProfile()); } catch {}
});

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
