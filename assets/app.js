// assets/app.js
import { API_URL } from "./config.js";

const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const saveBtn = document.getElementById("save");
const personaSel = document.getElementById("persona");
const worldEl = document.getElementById("world");
const modelSel = document.getElementById("model");
const tts = document.getElementById("tts");

const PERSONAS = {
  elyo: { name:"Élyo", bio:"apprenti technicien des éoliennes, curieux et calme (pro-éolien, attentif aux oiseaux et au paysage)" },
  nae:  { name:"Naé",  bio:"apprentie chamane des Belles-Terres (protège les terres sacrées, ouverte aux éoliennes en zones neutres)" },
  mika: { name:"Mika", bio:"employé·e local·e de Creuser-Puiser (emplois, mines et éoliennes locales, veut des garanties environnementales)" },
  lia:  { name:"Lia",  bio:"militante Liberté & Nature (préserver les biotopes, pro-écotourisme, contre mines et éoliennes)" },
  teo:  { name:"Téo",  bio:"pêche & chevaux tradition (prudent avec tourisme de masse et éoliennes)" },
};

const DEFAULT_WORLD = {
  lieu: "Forum de parole de la Côte-Nord (vents forts)",
  enjeux: ["mines de terres rares (néodyme)", "parcs éoliens côtiers", "écotourisme"],
  rappel: "Rester respectueux, écouter, poser des questions courtes.",
  note: "Les élèves écrivent une 'Ma trace' en 1 phrase à la fin de chaque tour."
};

let history = []; // { role: "user"|"assistant", content: "..." }

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "card msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  if (role === "assistant" && tts?.checked && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text.replace(/👍|ℹ️|❓|✍️/g,""));
    u.lang = "fr-CH";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // sauvegarde locale (optionnelle)
  localStorage.setItem("bt_demo_history", JSON.stringify(history));
}

async function sendMsg() {
  const content = inputEl.value.trim();
  if (!content) return;

  history.push({ role: "user", content });
  addMsg("user", content);
  inputEl.value = "";

  const persona = PERSONAS[personaSel.value];
  let world;
  try { world = JSON.parse(worldEl.value || "{}"); }
  catch { world = DEFAULT_WORLD; }

  const r = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ messages: history, persona, world, model: modelSel?.value || "gpt-4o-mini" })
  });
  const data = await r.json();
  const reply = data.reply || "(pas de réponse)";
  history.push({ role:"assistant", content: reply });
  addMsg("assistant", reply);
}

async function saveTranscript() {
  const sessionId = crypto.randomUUID();
  // NDJSON : 1 message par ligne, avec timestamp
  const transcript = history.map(m => JSON.stringify({ ts: Date.now(), ...m })).join("\n");
  await fetch(`${API_URL}/save`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ sessionId, transcript, contentType:"application/x-ndjson" })
  });
  alert("Session enregistrée (R2).");
}

// UI hooks
sendBtn.onclick = sendMsg;
saveBtn.onclick = saveTranscript;

// init
document.addEventListener("DOMContentLoaded", () => {
  worldEl.value = JSON.stringify(DEFAULT_WORLD, null, 2);
  try {
    const prev = JSON.parse(localStorage.getItem("bt_demo_history") || "[]");
    if (prev.length) {
      history = prev;
      for (const m of prev) addMsg(m.role === "user" ? "user" : "assistant", m.content);
    }
  } catch {}
});
