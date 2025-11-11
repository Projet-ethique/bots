// assets/app.js
import { API_BASE } from "./config.js";
import { makeSystem } from "./prompt.js";

const chatEl     = document.getElementById("chat");
const inputEl    = document.getElementById("input");
const sendBtn    = document.getElementById("send");
const saveBtn    = document.getElementById("save");
const resetBtn   = document.getElementById("reset");
const personaSel = document.getElementById("persona");
const worldTa    = document.getElementById("world");
const modelSel   = document.getElementById("model");
const ttsChk     = document.getElementById("tts");

let PERSONAS = {};
let DEFAULT_WORLD = {};
let history = [];                 // [{ role:"user"|"assistant", content:string }]
let sessionId = crypto.randomUUID(); // un identifiant par “séance” (réinitialisé sur reset)

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "card msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  if (role === "assistant" && ttsChk?.checked && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-CH";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
  localStorage.setItem("bt_demo_history", JSON.stringify(history));
}

async function loadData() {
  // charge les personas (garde l’objet complet, pour tics/questioning/etc.)
  const list = await fetch("./data/personas.json").then(r => r.json());
  PERSONAS = Object.fromEntries(list.map(x => [x.id, x]));
  personaSel.innerHTML = list.map(x => `<option value="${x.id}">${x.name}</option>`).join("");

  // charge le monde par défaut
  DEFAULT_WORLD = await fetch("./data/world.json").then(r => r.json());
  worldTa.value = JSON.stringify(DEFAULT_WORLD, null, 2);

  // restaure l'historique local si présent
  try {
    const prev = JSON.parse(localStorage.getItem("bt_demo_history") || "[]");
    if (prev.length) {
      history = prev;
      for (const m of prev) addMsg(m.role, m.content);
    }
  } catch {}

  inputEl?.focus();
}

personaSel.onchange = () => {
  // Pour l’immersion, on redémarre la session quand on change de personnage
  resetConversation();
};

function resetConversation() {
  // Stoppe toute voix en cours
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();

  // Vide historique + UI + stockage local
  history = [];
  chatEl.innerHTML = "";
  localStorage.removeItem("bt_demo_history");

  // Nouveau sessionId
  sessionId = crypto.randomUUID();

  // Remet le monde par défaut (si tu veux conserver les edits prof, commente la ligne suivante)
  worldTa.value = JSON.stringify(DEFAULT_WORLD, null, 2);

  // Nettoie l’input et remet le focus
  inputEl.value = "";
  inputEl.focus();
}

async function sendMsg() {
  const content = inputEl.value.trim();
  if (!content) return;

  history.push({ role: "user", content });
  addMsg("user", content);
  inputEl.value = "";

  const pid = personaSel.value;
  const persona = PERSONAS[pid] || PERSONAS[Object.keys(PERSONAS)[0]];
  let world;
  try { world = JSON.parse(worldTa.value || "{}"); } catch { world = DEFAULT_WORLD; }

  const system = makeSystem(persona, world);
  const model  = modelSel?.value || "gpt-4o-mini";

  const r = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history, system, model })
  });
  const data = await r.json();
  const reply = data.reply || "(pas de réponse)";
  history.push({ role:"assistant", content: reply });
  addMsg("assistant", reply);
}

async function saveTranscript() {
  // NDJSON (1 ligne = 1 message)
  const transcript = history.map(m => JSON.stringify({ ts: Date.now(), ...m })).join("\n");
  await fetch(`${API_BASE}/save`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ sessionId, transcript, contentType:"application/x-ndjson" })
  });
  alert("Session enregistrée (R2).");
}

document.addEventListener("DOMContentLoaded", loadData);
sendBtn.onclick  = sendMsg;
saveBtn.onclick  = saveTranscript;
resetBtn.onclick = resetConversation;
