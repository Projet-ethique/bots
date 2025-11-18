// worker-belles-terres/src/index.js
// API Belles-Terres (Cloudflare Worker):
//   - POST /api/chat        (OpenAI par défaut ; Gemini si model commence par "gemini-")
//   - POST /api/save
//   - GET/POST /api/memory
//   - GET/POST /api/tts     (OpenAI TTS, stream audio; supporte ?style= …)
//
// Requiert: env.OPENAI_API_KEY ; (optionnel) env.GEMINI_API_KEY si usage Gemini
// Binding R2: LOGS_BUCKET
// CORS inclus.

const OPENAI = "https://api.openai.com/v1";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    try {
      // ---- TTS ----
      if (url.pathname === "/api/tts") {
        return handleTts(req, env, url);
      }

      // ---- Chat ----
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const { messages = [], system = "", model = "gpt-4o-mini", temperature = 0.7 } = await req.json();

        // Branche Gemini si le modèle commence par "gemini-"
        if (model && model.startsWith("gemini-")) {
          if (!env.GEMINI_API_KEY) return json({ error: "gemini_api_key_missing" }, 500);

          // Convertit l'historique au format Gemini
          const toGemini = (msgs) =>
            msgs
              .filter(m => m && m.role && typeof m.content === "string" && m.content.trim().length)
              .map(m => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }]
              }));

          const gReq = {
            contents: toGemini(messages),
            generationConfig: { temperature }
          };
          if (system && system.trim()) {
            gReq.systemInstruction = { parts: [{ text: system }] };
          }

          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gReq) }
          );

          if (!r.ok) {
            const t = await r.text().catch(() => "");
            return json({ error: "gemini_error", detail: t }, r.status);
          }

          const data = await r.json();
          const reply =
            (data?.candidates?.[0]?.content?.parts || [])
              .map(p => p?.text || "")
              .join("") || "";
          return json({ reply });
        }

        // --- OpenAI (par défaut)
        const body = {
          model,
          temperature,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            ...messages
          ]
        };

        const r = await fetch(`${OPENAI}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });

        if (!r.ok) {
          const t = await r.text().catch(() => "");
          return json({ error: "openai_error", detail: t }, r.status);
        }

        const j = await r.json();
        const reply = j?.choices?.[0]?.message?.content ?? "";
        return json({ reply });
      }

      // ---- Save transcript NDJSON into R2 ----
      if (url.pathname === "/api/save" && req.method === "POST") {
        const {
          sessionId,
          transcript,
          classId = "default",
          userId = "anon",
          contentType = "text/plain"
        } = await req.json();

        if (!sessionId || !transcript) return json({ error: "bad_request" }, 400);

        const key = `logs/${classId}/${new Date().toISOString().slice(0,10)}_${sessionId}.ndjson`;
        await env.LOGS_BUCKET.put(key, transcript, { httpMetadata: { contentType } });
        return json({ ok: true, key });
      }

      // ---- Memory (small JSON blob per class/user) ----
      if (url.pathname === "/api/memory") {
        if (req.method === "GET") {
          const classId = url.searchParams.get("classId") || "default";
          const userId  = url.searchParams.get("userId")  || "anon";
          const key = `memory/${classId}/${userId}.json`;
          const obj = await env.LOGS_BUCKET.get(key);
          const mem = obj ? await obj.json() : { summary: "", notes: [] };
          return new Response(JSON.stringify(mem), { status: 200, headers: jsonHeaders() });
        }
        if (req.method === "POST") {
          const { classId = "default", userId = "anon", memory } = await req.json();
          if (!memory) return json({ error: "bad_request" }, 400);
          const key = `memory/${classId}/${userId}.json`;
          await env.LOGS_BUCKET.put(key, JSON.stringify(memory), {
            httpMetadata: { contentType: "application/json" }
          });
          return json({ ok: true, key });
        }
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "exception", detail: String(e) }, 500);
    }
  }
};

// ===== Helpers =====
function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Vary": "Origin",
    ...extra
  };
}
function jsonHeaders() {
  return cors({ "Content-Type": "application/json; charset=utf-8" });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: jsonHeaders() });
}

async function handleTts(req, env, url) {
  // Valeurs par défaut
  let text   = "";
  let voice  = "alloy";
  let model  = "gpt-4o-mini-tts";
  let format = "mp3"; // mp3 / wav / opus …
  let style  = "";    // <- NOUVEAU

  // 1) Lire body (POST)
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const b = await req.json().catch(() => ({}));
      text   = (b.text   ?? text).toString();
      voice  = (b.voice  ?? voice);
      model  = (b.model  ?? model);
      format = (b.format ?? format);
      style  = (b.style  ?? style);
    } else if (ct.startsWith("text/")) {
      text = await req.text();
    }
  } else if (req.method === "GET") {
    text = url.searchParams.get("text") || text;
  }

  // 2) Query params (surchargent)
  voice  = url.searchParams.get("voice")  || voice;
  model  = url.searchParams.get("model")  || model;
  format = url.searchParams.get("format") || format;
  style  = url.searchParams.get("style")  || style;
  if (!text && url.searchParams.get("text")) text = url.searchParams.get("text");

  if (!text || !text.trim()) return json({ error: "missing_text" }, 400);
  if (!env.OPENAI_API_KEY)   return json({ error: "OPENAI_API_KEY missing" }, 500);

  // 3) Injection de style dans l’input (prompt TTS)
  //    On guide la voix: accent, émotion, intonation, vitesse, ton, chuchoté, etc.
  const styledInput = style
    ? `Read the following in this style (keep it natural and in French if the text is French): ${style}\n\nText:\n${text}`
    : text;

  const upstream = await fetch(`${OPENAI}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, voice, input: styledInput, format })
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "openai_tts_error", detail }, upstream.status);
  }

  const contentType =
    format === "wav"  ? "audio/wav"  :
    format === "opus" ? "audio/ogg"  :
    /* mp3 */           "audio/mpeg";

  return new Response(upstream.body, {
    status: 200,
    headers: cors({
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    })
  });
}
