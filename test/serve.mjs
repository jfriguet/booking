// Serveur local de test : fichiers statiques + API avec un faux stockage (aucun compte Netlify requis).
import http from "node:http";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

export async function demarrer(port = 8899) {
  const tmp = mkdtempSync(join(tmpdir(), "serve-"));
  mkdirSync(join(tmp, "netlify/functions"), { recursive: true });
  const src = readFileSync("netlify/functions/api.mjs", "utf8")
    .replace('import { getStore } from "@netlify/blobs";', `const mem = (globalThis.__mem ??= new Map());
const getStore = () => ({
  async getWithMetadata(k) { const v = mem.get(k); return v ? { data: JSON.parse(v.json), etag: String(v.n), metadata: {} } : null; },
  async setJSON(k, data, o = {}) {
    const v = mem.get(k);
    if (o.onlyIfNew && v) return { modified: false };
    if (o.onlyIfMatch && (!v || String(v.n) !== o.onlyIfMatch)) return { modified: false };
    mem.set(k, { json: JSON.stringify(data), n: (v?.n ?? 0) + 1 });
    return { modified: true };
  },
});`)
    .replace('"../../public/logic.js"', JSON.stringify(pathToFileURL(join(process.cwd(), "public/logic.js")).href));
  writeFileSync(join(tmp, "netlify/functions/api.mjs"), src);
  process.env.ADMIN_PASSWORD = "secret";
  const { default: handler } = await import(pathToFileURL(join(tmp, "netlify/functions/api.mjs")).href);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await handler(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const f = join("public", url.pathname === "/" ? "index.html" : url.pathname);
    if (!existsSync(f)) return res.writeHead(404).end("introuvable");
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(port, r));
  return { server, url: `http://localhost:${port}` };
}

if (process.argv[1] && process.argv[1].endsWith("serve.mjs")) {
  const { url } = await demarrer();
  console.log("Serveur de test sur", url, "(mot de passe : secret)");
}
