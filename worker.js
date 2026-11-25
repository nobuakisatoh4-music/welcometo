// Cloudflare Worker: /flute-concerto/api/* (フィードバック・PDF差し替え用のAPI)
// それ以外のURLは、これまでどおり静的ファイルとして配信されます。
const BASE = '/flute-concerto/api/';
const MAX_PDF = 24 * 1024 * 1024; // KVの1件あたり上限(25MiB)の手前
const PART = /^[a-z0-9-]{1,40}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function same(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function isAdmin(req, env) {
  const pw = env.ADMIN_PASSWORD;
  if (!pw) return false;
  let given = req.headers.get('x-admin-password') || '';
  try { given = decodeURIComponent(given); } catch (e) {}
  return same(given, pw);
}

async function load(env) {
  const s = await env.DATA.get('state', 'json');
  const o = s && typeof s === 'object' ? s : {};
  return { files: o.files || {}, feedback: o.feedback || {}, fbdone: o.fbdone || {} };
}
const save = (env, s) => env.DATA.put('state', JSON.stringify(s));

function clip(v, n) {
  return typeof v === 'string' ? v.trim().slice(0, n) : '';
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(BASE)) return env.ASSETS.fetch(req);
    if (!env.DATA) return J({ error: 'storage not configured' }, 503);

    const path = url.pathname.slice(BASE.length);
    const seg = path.split('/');
    const m = req.method;
    const admin = () => isAdmin(req, env);

    try {
      if (path === 'state' && m === 'GET') return J(await load(env));

      if (path === 'auth' && m === 'POST') {
        if (!env.ADMIN_PASSWORD) return J({ error: 'admin password not set' }, 503);
        return admin() ? J({ ok: true }) : J({ ok: false }, 401);
      }

      // フィードバック投稿（誰でも可）
      if (path === 'feedback' && m === 'POST') {
        const raw = await req.text();
        if (raw.length > 6000) return J({ error: 'too large' }, 413);
        let b;
        try { b = JSON.parse(raw); } catch (e) { return J({ error: 'bad json' }, 400); }
        const rec = {
          part: clip(b.part, 40),
          partName: clip(b.partName, 80),
          name: clip(b.name, 40),
          bar: clip(b.bar, 20),
          text: clip(b.text, 1000),
          at: Date.now(),
        };
        if (!PART.test(rec.part) || !rec.name || !rec.bar || !rec.text) return J({ error: 'invalid' }, 400);
        const id = 'f' + rec.at.toString(36) + Math.random().toString(36).slice(2, 7);
        const s = await load(env);
        s.feedback[id] = rec;
        await save(env, s);
        return J({ id, at: rec.at });
      }

      // フィードバックの削除（管理）
      if (seg[0] === 'feedback' && ID.test(seg[1] || '') && m === 'DELETE') {
        if (!admin()) return J({ error: 'unauthorized' }, 401);
        const s = await load(env);
        delete s.feedback[seg[1]];
        delete s.fbdone[seg[1]];
        await save(env, s);
        return J({ ok: true });
      }

      // 解決済みの切り替え（管理）
      if (seg[0] === 'fbdone' && ID.test(seg[1] || '') && (m === 'PUT' || m === 'DELETE')) {
        if (!admin()) return J({ error: 'unauthorized' }, 401);
        const s = await load(env);
        if (m === 'PUT') s.fbdone[seg[1]] = { done: true, at: Date.now() };
        else delete s.fbdone[seg[1]];
        await save(env, s);
        return J({ ok: true });
      }

      // PDFの差し替え・元に戻す（管理）
      if (seg[0] === 'file' && PART.test(seg[1] || '') && (m === 'PUT' || m === 'DELETE')) {
        if (!admin()) return J({ error: 'unauthorized' }, 401);
        const part = seg[1];
        const s = await load(env);
        const old = s.files[part];
        if (m === 'PUT') {
          const buf = await req.arrayBuffer();
          if (buf.byteLength < 8 || buf.byteLength > MAX_PDF) return J({ error: 'size' }, 413);
          const head = new Uint8Array(buf, 0, 4);
          if (String.fromCharCode(...head) !== '%PDF') return J({ error: 'not pdf' }, 400);
          let name = req.headers.get('x-filename') || '';
          try { name = decodeURIComponent(name); } catch (e) {}
          const id = Date.now().toString(36);
          await env.DATA.put('blob:' + part + ':' + id, buf);
          const meta = { id, name: name.slice(0, 120), size: buf.byteLength, updatedAt: Date.now(), url: 'api/blob/' + part + '/' + id };
          s.files[part] = meta;
          await save(env, s);
          if (old && old.id) await env.DATA.delete('blob:' + part + ':' + old.id);
          return J(meta);
        }
        delete s.files[part];
        await save(env, s);
        if (old && old.id) await env.DATA.delete('blob:' + part + ':' + old.id);
        return J({ ok: true });
      }

      // 差し替え後のPDFの配信
      if (seg[0] === 'blob' && PART.test(seg[1] || '') && ID.test(seg[2] || '') && m === 'GET') {
        const body = await env.DATA.get('blob:' + seg[1] + ':' + seg[2], 'stream');
        if (!body) return J({ error: 'not found' }, 404);
        return new Response(body, {
          headers: {
            'content-type': 'application/pdf',
            'cache-control': 'public, max-age=31536000, immutable',
          },
        });
      }
    } catch (e) {
      return J({ error: 'server error' }, 500);
    }
    return J({ error: 'not found' }, 404);
  },
};
