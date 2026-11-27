// Cloudflare Pages Function: /api/state
// GET  -> the saved site text (JSON), or {} if nothing saved yet
// POST -> save new site text; needs the x-password header to match the ADMIN_PASSWORD secret
// Needs: a KV namespace bound as SITE, and a secret named ADMIN_PASSWORD (Pages project > Settings).
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
};

export async function onRequestGet({ env }) {
  if (!env.SITE) return json({ error: 'KV binding SITE is missing' }, 500);
  return json((await env.SITE.get('state')) || '{}');
}

export async function onRequestPost({ request, env }) {
  if (!env.SITE) return json({ error: 'KV binding SITE is missing' }, 500);
  if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD secret is missing' }, 500);
  if (!same(request.headers.get('x-password') || '', env.ADMIN_PASSWORD)) return json({ error: 'wrong password' }, 401);
  const text = await request.text();
  if (text.length > 300000) return json({ error: 'too large' }, 413);
  let data;
  try { data = JSON.parse(text); } catch { return json({ error: 'not JSON' }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'bad data' }, 400);
  await env.SITE.put('state', JSON.stringify(data));
  return json({ ok: true });
}
