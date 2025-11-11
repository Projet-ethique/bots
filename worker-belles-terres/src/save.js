// worker-belles-terres/src/save.js
export async function handleSave(req, env) {
  const origin = req.headers.get("Origin");
  const cors = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json"
  };

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: cors });

  if (!env.LOGS_BUCKET) {
    return new Response(JSON.stringify({ error: "Binding R2 LOGS_BUCKET manquant" }), { status: 501, headers: cors });
  }

  const { sessionId, transcript, contentType = "application/x-ndjson" } = await req.json();
  if (!sessionId || !transcript) {
    return new Response(JSON.stringify({ error: "sessionId et transcript requis" }), { status: 400, headers: cors });
  }

  const key = `logs/${sessionId}-${Date.now()}.jsonl`; // NDJSON (1 ligne = 1 message)
  await env.LOGS_BUCKET.put(key, transcript, { httpMetadata: { contentType } }); // écriture R2
  return new Response(JSON.stringify({ ok: true, key }), { headers: cors });
}
