import { handleChat } from "./chat.js";
import { handleSave } from "./save.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const cors = makeCors(origin);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/api/chat" && req.method === "POST") return withCors(await handleChat(req, env), cors);
      if (url.pathname === "/api/save" && req.method === "POST") return withCors(await handleSave(req, env), cors);
      if (url.pathname === "/") return new Response("OK", { headers: cors });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
    }
  }
};
function makeCors(origin){ const allow = origin || "*";
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods":"POST, OPTIONS, GET", "Access-Control-Allow-Headers":"Content-Type", "Cache-Control":"no-store" };
}
function withCors(resp, cors){ const h=new Headers(resp.headers); for (const [k,v] of Object.entries(cors)) h.set(k,v); return new Response(resp.body,{status:resp.status,headers:h});}
