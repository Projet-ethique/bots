// worker-belles-terres/tts.js
// Proxy TTS OpenAI + cache R2 (même bucket LOGS_BUCKET déjà lié)
// Requiert: OPENAI_API_KEY (déjà présent chez toi)

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function handleTts(req, env) {
  try {
    const url = new URL(req.url);
    const model = url.searchParams.get("model") || "gpt-4o-mini-tts";
    const voice = url.searchParams.get("voice") || "alloy";
    const format = url.searchParams.get("format") || "mp3"; // mp3/wav/opus etc.
    const body = await req.json().catch(() => ({}));
    const text = (body?.text || body?.input || "").toString();

    if (!text.trim()) {
      return new Response(JSON.stringify({ error: "Missing text" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }
    if (!env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY missing" }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    // ---- Cache R2 (optionnel, utilise ton LOGS_BUCKET existant) ----
    const keyHash = await sha256Hex(`${model}|${voice}|${format}|${text}`);
    const r2Key = `tts-cache/openai/${model}/${voice}/${keyHash}.${format}`;
    try {
      const obj = await env.LOGS_BUCKET.get(r2Key);
      if (obj) {
        return new Response(obj.body, {
          headers: { "Content-Type": (format === "mp3" ? "audio/mpeg" : `audio/${format}`),
                     "Cache-Control": "no-store" }
        });
      }
    } catch {}

    // ---- Appel OpenAI /v1/audio/speech ----
    // Docs: models gpt-4o-mini-tts + endpoint audio/speech. :contentReference[oaicite:0]{index=0}
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        format // "mp3" recommandé (latence faible)
      })
    });

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => "upstream error");
      return new Response(JSON.stringify({ error: errTxt }), {
        status: 502, headers: { "Content-Type": "application/json" }
      });
    }

    // Stream → buffer (pour écrire en R2), puis renvoyer
    const audioBuf = await upstream.arrayBuffer();
    await env.LOGS_BUCKET.put(r2Key, audioBuf, {
      httpMetadata: { contentType: (format === "mp3" ? "audio/mpeg" : `audio/${format}`) }
    });

    return new Response(audioBuf, {
      headers: { "Content-Type": (format === "mp3" ? "audio/mpeg" : `audio/${format}`),
                 "Cache-Control": "no-store" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "TTS handler error" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
