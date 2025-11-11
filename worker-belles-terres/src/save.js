export async function handleSave(req, env) {
  if (!env.LOGS_BUCKET) return json({ error: "Binding R2 LOGS_BUCKET manquant" }, 501);

  const { sessionId, transcript, contentType = "application/x-ndjson" } = await req.json();
  if (!sessionId || !transcript) return json({ error: "sessionId et transcript requis" }, 400);

  const key = `logs/${sessionId}-${Date.now()}.jsonl`;
  await env.LOGS_BUCKET.put(key, transcript, { httpMetadata: { contentType } }); // R2 binding
  return json({ ok: true, key }, 200);
}
function json(obj, status=200, extra={}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type":"application/json", ...extra }});
}
