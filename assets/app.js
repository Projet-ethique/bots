// assets/app.js
import { API_BASE, HAS_MEMORY } from "./config.js";
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
const avatarEl   = document.getElementById("avatar");

const feedbackBox    = document.getElementById("feedbackBox");
const feedbackBtn    = document.getElementById("feedbackSend");
const feedbackStatus = document.getElementById("feedbackStatus");

// Déverrouille l'audio au premier clic (autoplay policy)
document.addEventListener("click", () => {
  try { const a = new Audio(); a.muted = true; a.play?.().catch(()=>{}); } catch {}
}, { once: true });

// (optionnel) identifiants classe/élève
const classInput = document.getElementById("classId");
const userInput  = document.getElementById("userId");

/* ============ État ============ */
let PERSONAS = {};          // { id: { name, sfxProfile, piperVoice, speaker, … } }
let DEFAULT_WORLD = {};
let history = [];
let sessionId = crypto.randomUUID();
let MEMORY = { summary: "", notes: [] };
let HISTORY_BY_PERSONA = {};
let CURRENT_PID = null;

// Banque de questions (respect/justice/liberté/…)
let QUESTION_BANK = {};

// Pending bubble (…)
let pendingEl = null;

// -- TTS guard & watchdog --
let TTS_LOCK = false;
const POKET_TIMEOUT_MS = 9000; // 9s puis fallback

// ==== Cloud TTS (OpenAI) ====
let USE_CLOUD_TTS = true;                   // TTS prioritaire
const CLOUD_TTS_MODEL = "gpt-4o-mini-tts";  // rapide/éco
const SYNC_TEXT_WITH_AUDIO = true;          // texte s’affiche quand l’audio démarre

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
let USE_PIPER_POKET    = true;   // support 'speaker'
let USE_PIPER_MINTPLEX = false;  // repli simple si besoin

let ttsPoket = null;
let poketEngine = null;
let ttsMint = null;
let TTS_VOICE_CACHE = {}; // { personaId : voiceId }

/** 🔧 Réécriture ciblée des fetch de la lib pour pointer vers /assets/vendor/piper-tts-web */
function wirePiperPathRewrite() {
  if (wirePiperPathRewrite._done) return;
  wirePiperPathRewrite._done = true;
  const ORIG = window.fetch.bind(window);
  const base = new URL("./vendor/piper-tts-web/", import.meta.url).href; // ./assets/vendor/piper-tts-web/
  function map(u) {
    if (typeof u !== "string") return u;
    if (u.startsWith("/piper/"))   return base + "piper/"  + u.slice("/piper/".length);
    if (u.startsWith("piper/"))    return base + u;
    if (u.startsWith("onnx/"))     return base + u;
    if (u.startsWith("worker/"))   return base + u;
    return u;
  }
  window.fetch = (input, init) => ORIG(map(input), init);
}

/* --- Poket-Jony (self-host) --- */
async function ensurePoketLoaded() {
  if (!USE_PIPER_POKET) return false;
  if (ttsPoket) return true;
  wirePiperPathRewrite(); // important: avant import()
  const candidates = [
    "./vendor/piper-tts-web/piper-tts-web.js",
    "./vendor/piper-tts-web/index.min.js",
    "./vendor/piper-tts-web/index.js"
  ];
  for (const p of candidates) {
    try { ttsPoket = await import(p); console.info("[TTS] piper lib importée:", p); return true; } catch {}
  }
  console.warn("Piper (Poket-Jony) introuvable dans assets/vendor/piper-tts-web/");
  return false;
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

/* --- Choix de la voix Piper --- */
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
  return normalizeVoiceId(persona.piperVoice) || "fr_FR-mls-medium";
}

/* —— Nettoyage NV pour affichage —— */
function stripNvForDisplay(text) {
  return String(text)
    .replace(/<nv\b[^>]*\/>/gi, " ")
    .replace(/<nv\b[^>]*>([\s\S]*?)<\/nv>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ====== SFX non-verbaux ====== */
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
    grunt:   "./assets/sfx/grunt_male.wav",
    sigh:    "./assets/sfx/sigh_woman.wav",
    chuckle: "./assets/sfx/chuckle_woman.wav",
    hmm:     "./assets/sfx/hmm_woman.wav",
  }
};
const NV_MAP = { "grogne":"grunt", "soupir":"sigh", "soupire":"sigh", "rire":"chuckle", "hum":"hmm", "hmm":"hmm" };
const AUDIO_CACHE = {};
function getSfxProfile(){
  const pid = personaSel.value;
  const p = PERSONAS[pid] || {};
  const g = (p.sfxProfile || p.gender || "").toLowerCase();
  return g.includes("fem") ? "female" : g.includes("hom") || g.includes("masc") ? "male" : "default";
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
      try { const a = new Audio(url); a.preload = "auto"; AUDIO_CACHE[url] = a; } catch {}
    }
  }
}
function parseNonVerbalsForTTS(text) {
  let s = String(text);
  const found = [];
  s = s.replace(/<nv\b([^>]*?)\/>/gi, (_, attrs) => {
    const t = /type\s*=\s*["']?([\w-]+)["']?/i.exec(attrs);
    const raw = (t && t[1] || "").toLowerCase();
    const key = NV_MAP[raw] || raw; if (key) found.push(key); return " … ";
  });
  s = s.replace(/<nv\b[^>]*>([\s\S]*?)<\/nv>/gi, (_, inner) => {
    const raw = (inner || "").trim().toLowerCase();
    const key = NV_MAP[raw] || raw; if (key) found.push(key); return " … ";
  });
  s = s.replace(/\b[hH]mpf+[\.\!\?]*/g, " … ").replace(/\((?:grogne|soupire|soupir|rire|hum|hmm)\)/gi, " … ");
  s = s.replace(/\*[^*]{0,30}\*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!s) s = "…";
  const sfx = found.map(x => (NV_MAP[x] || x)).filter(x => ["grunt","sigh","chuckle","hmm"].includes(x));
  return { clean: s, sfx };
}

/* ====== Helpers SFX & pending ====== */
function playOneSfxAndWait(url, maxMs=800){
  return new Promise(resolve=>{
    try{
      const a = new Audio(url);
      let done=false;
      const timer=setTimeout(()=>{ if(!done){ done=true; resolve(); } }, maxMs);
      a.onended=()=>{ if(!done){ done=true; clearTimeout(timer); resolve(); } };
      a.onerror=()=>{ if(!done){ done=true; clearTimeout(timer); resolve(); } };
      a.play()?.catch(()=>{ if(!done){ done=true; clearTimeout(timer); resolve(); }});
    }catch{ resolve(); }
  });
}
async function playSfxThen(keys, profile){
  if (!keys?.length) return;
  const p = profile || "default";
  for (const k of keys){
    const url = pickSfxFile(p, k);
    if (url) await playOneSfxAndWait(url, 800);
  }
}
function showPending() {
  const div = document.createElement("div");
  div.className = "msg bot pending";
  div.textContent = "…";
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

/* ====== Bip test ====== */
window.btTestBeep = async function () {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = 880;
    gain.gain.value = 0.07;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 500);
    console.info("[TTS] beep ok");
  } catch (e) { console.warn("[TTS] beep failed:", e); }
};

// ====== Cloud TTS (OpenAI via Worker) — avec style & rate ======
async function speakWithCloudTTS(text, sfxKeys, sfxProfile, onStart){
  // 1) SFX d’abord
  await playSfxThen(sfxKeys, sfxProfile);

  // 2) Persona → voix + style
  const pid     = personaSel.value || Object.keys(PERSONAS)[0];
  const persona = PERSONAS[pid] || {};
  const voiceId = persona.openaiVoice || persona.ttsVoiceId || "alloy";
  const style   = persona.openaiStyle || "";
  const rate    = Number(persona.openaiRate || 1.0);

  // 3) Appel Worker
  const res = await fetch(`${API_BASE}/tts?voice=${encodeURIComponent(voiceId)}&model=${encodeURIComponent(CLOUD_TTS_MODEL)}&format=mp3`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ text, style })
  });
  if (!res.ok) throw new Error(`Cloud TTS HTTP ${res.status}`);
  const blob = await res.blob();

  // 4) Lecture audio
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  if (typeof onStart === "function") {
    audio.addEventListener("playing", () => { try { onStart(); } catch {} }, { once: true });
  }
  if (rate && isFinite(rate) && rate > 0.5 && rate < 1.5) {
    try { audio.playbackRate = rate; } catch {}
  }
  await audio.play();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 15000);
}

/* ====== Synthèse principale ====== */
async function speakWithPiper(text, opts = {}) {
  if (!ttsChk?.checked) return;
  const { clean, sfx } = parseNonVerbalsForTTS(text);
  const pid = personaSel.value || Object.keys(PERSONAS)[0];
  const profile = getSfxProfile();

  // 0) Cloud TTS prioritaire
  if (USE_CLOUD_TTS) {
    try {
      await speakWithCloudTTS(clean, sfx, profile, opts?.onStart);
      return;
    } catch (e) {
      console.warn("[Cloud TTS] échec, on tente Piper :", e);
    }
  }

  // (A) Poket-Jony
  if (USE_PIPER_POKET) {
    if (TTS_LOCK) { console.info("[TTS] lock: génération déjà en cours, on ignore."); }
    else {
      TTS_LOCK = true;
      try {
        await ensurePoketLoaded();
        if (!poketEngine) {
          let rt = null;
          if (ttsPoket?.OnnxWebWorkerRuntime) {
            rt = new ttsPoket.OnnxWebWorkerRuntime();
            console.info("[TTS] Runtime ONNX WASM (worker) sélectionné.");
          } else if (ttsPoket?.OnnxWebGPUWorkerRuntime && navigator.gpu) {
            rt = new ttsPoket.OnnxWebGPUWorkerRuntime();
            console.info("[TTS] Runtime WebGPU sélectionné (fallback WASM indisponible).");
          }
          if (ttsPoket?.PiperWebWorkerEngine && rt && ttsPoket?.HuggingFaceVoiceProvider) {
            poketEngine = new ttsPoket.PiperWebWorkerEngine({
              onnxRuntime:  rt,
              voiceProvider: new ttsPoket.HuggingFaceVoiceProvider()
            });
          } else if (ttsPoket?.PiperWebEngine) {
            poketEngine = new ttsPoket.PiperWebEngine();
            console.info("[TTS] PiperWebEngine (non-worker) utilisé.");
          }
        }

        if (poketEngine) {
          const persona = PERSONAS[pid] || {};
          const voice   = await pickVoiceForPersona(pid);
          const spRaw   = persona.speaker ?? persona.piperSpeaker;
          const speaker = Number.isFinite(Number(spRaw)) ? Number(spRaw) : 0;

          const tlabel = `[TTS] generate ${Date.now()}`;
          console.time(tlabel);
          const genPromise    = poketEngine.generate(clean, voice, speaker);
          const timeoutPromise= new Promise((_, rej) => setTimeout(() => rej(new Error("TTS timeout")), POKET_TIMEOUT_MS));
          let resp;
          try { resp = await Promise.race([genPromise, timeoutPromise]); }
          finally { try { console.timeEnd(tlabel); } catch {} }

          const blob = resp?.file ?? resp?.wav ?? (resp instanceof Blob ? resp : null);
          if (!blob || !blob.size) throw new Error("Piper returned no/empty Blob");

          await playSfxThen(sfx, profile);

          const audio = document.createElement("audio");
          if (opts && typeof opts.onStart === "function") {
            audio.addEventListener("playing", () => { try { opts.onStart(); } catch {} }, { once: true });
          }
          audio.autoplay = true;
          const src = document.createElement("source");
          src.type = blob.type || "audio/wav";
          src.src  = URL.createObjectURL(blob);
          audio.appendChild(src);
          audio.onended = () => { try { URL.revokeObjectURL(src.src); } catch {} };
          document.body.appendChild(audio);
          await audio.play();
          setTimeout(() => { try { document.body.removeChild(audio); } catch {} }, 15000);
          return;
        }
      } catch (e) {
        console.warn("Poket-Jony a échoué (ou timeout); fallback :", e);
      } finally {
        TTS_LOCK = false;
      }
    }
  }

  // (B) Mintplex (pas de 'speaker')
  try {
    if (!USE_PIPER_MINTPLEX) throw new Error("Mintplex désactivé");
    await ensureMintplexLoaded();
    const voiceId = TTS_VOICE_CACHE[pid] || (TTS_VOICE_CACHE[pid] = await pickVoiceForPersona(pid));
    await playSfxThen(sfx, profile);
    const wav = await ttsMint.predict({ text: clean, voiceId });
    const audio = new Audio(URL.createObjectURL(wav));
    await audio.play();
    return;
  } catch (e) {
    // (C) Web Speech API
    if ("speechSynthesis" in window) {
      await playSfxThen(sfx, profile);
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "fr-FR";
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } else {
      console.warn("Aucune synthèse disponible :", e);
    }
  }
}

/* ============ Overlay boot ============ */
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

/* ============ Modèles ============ */
const MODEL_LIST = [
  { id: "gpt-4o-mini",   label: "gpt-4o-mini (recommandé)" },
  { id: "gpt-4o",        label: "gpt-4o" },
  { id: "gpt-4.1",       label: "gpt-4.1" },
  { id: "gpt-5",         label: "gpt-5 (si accès)" },
  { id: "gpt-3.5-turbo", label: "gpt-3.5-turbo (ancien)" },
  { id: "gemini-1.5-flash", label: "gemini-1.5-flash (Google)" },
  { id: "gemini-1.5-pro",   label: "gemini-1.5-pro (Google)" }

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

  // Banque de questions (avec override localStorage si présent)
  try {
    QUESTION_BANK = await fetch("./data/questions.json").then(r => r.ok ? r.json() : ({}));
  } catch { QUESTION_BANK = {}; }
  try {
    const saved = localStorage.getItem("bt_questions");
    if (saved) QUESTION_BANK = JSON.parse(saved);
  } catch {}

  // ÉDITEURS (bas) — remplissage à chaud
  try {
    const personasEd = document.getElementById("personasEditor");
    if (personasEd) {
      personasEd.value = JSON.stringify(list, null, 2);
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
  } catch {}
  try {
    const promptEd = document.getElementById("promptEditor");
    if (promptEd) promptEd.value = await fetch("./assets/prompt.js").then(r => r.text());
  } catch {}
  try {
    const qEd = document.getElementById("questionsEditor");
    if (qEd) {
      qEd.value = JSON.stringify(QUESTION_BANK, null, 2);
      qEd.addEventListener("change", () => {
        try {
          const obj = JSON.parse(qEd.value || "{}");
          QUESTION_BANK = obj;
          localStorage.setItem("bt_questions", JSON.stringify(obj));
          qEd.style.outline = "2px solid #2ecc71"; setTimeout(()=>qEd.style.outline="",700);
        } catch (e) {
          qEd.style.outline = "2px solid #e74c3c";
        }
      });
    }
  } catch {}

  // Historique local PAR PERSONA
  try {
    HISTORY_BY_PERSONA = JSON.parse(localStorage.getItem("bt_hist_by_pid") || "{}");
  } catch { HISTORY_BY_PERSONA = {}; }
  CURRENT_PID = personaSel.value || Object.keys(PERSONAS)[0];
  renderHistoryFor(CURRENT_PID);

  // Mémoire R2 (optionnelle)
  try { if (HAS_MEMORY) await loadMemory(); } catch {}

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
  if (!HAS_MEMORY) return;
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

/* ============ Scaffolding doux (valeur → graine) ============ */
function inferValueFocus(persona) {
  if (persona?.valueFocus) return persona.valueFocus;
  const g = (persona?.group || "").toLowerCase();
  if (g.includes("liberté")) return "liberte";
  if (g.includes("chaman")) return "respect";
  if (g.includes("creuser") || g.includes("puiser")) return "justice";
  if (g.includes("rebelle")) return "justice";
  if (g.includes("tradition")) return "responsabilite";
  return null;
}

/* ============ Chat UI ============ */
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "bot");

  // Si assistant + synchro activée + TTS actif → texte révélé au démarrage de l'audio
  if (role === "assistant" && SYNC_TEXT_WITH_AUDIO && ttsChk?.checked) {
    div.textContent = "…"; // placeholder
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    speakWithPiper(text, { onStart: () => { div.textContent = stripNvForDisplay(text); } });
  } else {
    const display = role === "assistant" ? stripNvForDisplay(text) : text;
    div.textContent = display;
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    if (role === "assistant") speakWithPiper(text);
  }

  const pidForSave = CURRENT_PID || (personaSel?.value || "default");
  HISTORY_BY_PERSONA[pidForSave] = history.slice();
  localStorage.setItem("bt_hist_by_pid", JSON.stringify(HISTORY_BY_PERSONA));
}

function addMsgSilent(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "bot");
  const display = role === "assistant" ? stripNvForDisplay(text) : text;
  div.textContent = display;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderHistoryFor(pid) {
  chatEl.innerHTML = "";
  history = (HISTORY_BY_PERSONA[pid] && Array.isArray(HISTORY_BY_PERSONA[pid]))
    ? HISTORY_BY_PERSONA[pid].slice()
    : [];
  for (const m of history) addMsgSilent(m.role, m.content);
}

personaSel?.addEventListener("change", () => {
  const prevPid = CURRENT_PID;
  HISTORY_BY_PERSONA[prevPid] = history.slice();
  localStorage.setItem("bt_hist_by_pid", JSON.stringify(HISTORY_BY_PERSONA));

  CURRENT_PID = personaSel.value || Object.keys(PERSONAS)[0];
  updateAvatar();
  try { preloadSfxProfile(getSfxProfile()); } catch {}

  renderHistoryFor(CURRENT_PID);
  inputEl?.focus();
});

function resetConversation() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  history = [];
  const pid = CURRENT_PID || (personaSel?.value || "default");
  HISTORY_BY_PERSONA[pid] = [];
  localStorage.setItem("bt_hist_by_pid", JSON.stringify(HISTORY_BY_PERSONA));
  chatEl.innerHTML = "";
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

  // Focus doux + graine
  const valueFocus = inferValueFocus(persona);
  let seedQuestion = null;
  if (valueFocus && QUESTION_BANK[valueFocus] && Array.isArray(QUESTION_BANK[valueFocus].initial)) {
    const pool = QUESTION_BANK[valueFocus].initial;
    if (pool.length) seedQuestion = pool[Math.floor(Math.random() * pool.length)];
  }
  const controls = {
    scaffoldIntensity: 1,     // 0 = libre, 1 = doux, 2 = plus guidé
    maxRelances: 1,           // 0..2
    showStructure: false,     // jamais de plan visible
    allowHedges: true         // amorces naturelles autorisées ("mmh, je vois…")
  };

  // System prompt
  const system = makeSystem(persona, { ...world, memory: MEMORY, valueFocus, controls, seedQuestion });
  const chosenModel = modelSel?.value || "gpt-4o-mini";

  let reply = "(pas de réponse)";

  // UI: pending + disable
  pendingEl = showPending();
  sendBtn.disabled = true;

  try {
    try {
      const r = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, system, persona, world, model: chosenModel })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || "API error");
      reply = data.reply || reply;
    } catch {
      try {
        const r2 = await fetch(`${API_BASE}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, system, persona, world, model: "gpt-4o-mini" })
        });
        const d2 = await r2.json();
        reply = d2.reply || reply;
      } catch {}
    }

    // Retire le pending avant d'ajouter la réponse
    if (pendingEl) { pendingEl.remove(); pendingEl = null; }

    history.push({ role:"assistant", content: reply });
    addMsg("assistant", reply);

    updateMemory(content, reply);
    saveMemory(); // async
  } finally {
    if (pendingEl) { pendingEl.remove(); pendingEl = null; }
    sendBtn.disabled = false;
  }
}

async function saveTranscript() {
  const transcript = history.map(m => JSON.stringify({ ts: Date.now(), ...m })).join("\n");
  await fetch(`${API_BASE}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
async function sendFeedback() {
  const txt = feedbackBox?.value?.trim();
  if (!txt) { if (feedbackStatus) feedbackStatus.textContent = "Écris un commentaire d'abord."; return; }

  const payload = {
    sessionId: `feedback-${crypto.randomUUID()}`,
    transcript: JSON.stringify({
      t: new Date().toISOString(),
      classId: getClassId(),
      userId: getUserId(),
      personaId: personaSel.value || CURRENT_PID || (Object.keys(PERSONAS)[0] || "default"),
      text: txt,
      ua: navigator.userAgent
    }) + "\n",
    classId: getClassId(),
    userId: getUserId(),
    contentType: "application/json"
  };

  try {
    const r = await fetch(`${API_BASE}/save`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if (r.ok) {
      if (feedbackStatus) feedbackStatus.textContent = "Envoyé ✓";
      if (feedbackBox) feedbackBox.value = "";
    } else {
      if (feedbackStatus) feedbackStatus.textContent = "Erreur d’envoi";
    }
  } catch {
    if (feedbackStatus) feedbackStatus.textContent = "Erreur réseau";
  }
  setTimeout(() => { if (feedbackStatus) feedbackStatus.textContent = ""; }, 2500);
}

/* ============ Boot ============ */
document.addEventListener("DOMContentLoaded", loadData);
sendBtn.onclick  = sendMsg;
saveBtn.onclick  = saveTranscript;
resetBtn && (resetBtn.onclick = resetConversation);
feedbackBtn && (feedbackBtn.onclick = sendFeedback);

inputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !sendBtn.disabled) { e.preventDefault(); sendMsg(); }
});
