// API proxy MSO — sin dependencias externas (Node stdlib)
// Recibe las consultas del dashboard, agrega x-api-key y las reenvía a kpi.red.com.sv.
//
// Local:      npm start            (lee la llave de .env)
// Desplegado: MSO_API_KEY como variable de entorno del servicio

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// .env solo para desarrollo local; al desplegar las variables las define el proveedor.
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT         = Number(process.env.PORT || 3000);
const HOST         = process.env.HOST || '0.0.0.0';
const MSO_BASE     = (process.env.MSO_API_BASE_URL || 'https://kpi.red.com.sv/api').replace(/\/$/, '');
const MSO_KEY      = process.env.MSO_API_KEY || '';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60000);
const TIMEOUT_MS   = Number(process.env.MSO_API_TIMEOUT_MS || 30000);
// "*" o lista separada por comas: https://dashboard.midominio.com,http://localhost:5500
const ALLOWED      = (process.env.ALLOW_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);

if (!MSO_KEY) {
  console.error('\n✖ Falta MSO_API_KEY.');
  console.error('  Local     : copiá .env.example a .env y completá la llave.');
  console.error('  Desplegado: definila como variable de entorno del servicio.\n');
  process.exit(1);
}

// Prefijos públicos → prefijos de la API MSO. El resto de la ruta pasa tal cual
// (así funcionan /casos/:id y /casos/:id/sims).
const MSO_PREFIX = {
  '/api/mso/simcards': '/dashboard-simcards',
  '/api/mso/reclamos': '/dashboard-reclamos-m2m',
};

function msoTarget(pathname) {
  for (const [local, remote] of Object.entries(MSO_PREFIX)) {
    if (pathname === local || pathname.startsWith(local + '/')) return remote + pathname.slice(local.length);
  }
  return null;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const base = { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (ALLOWED.includes('*')) return { ...base, 'Access-Control-Allow-Origin': '*' };
  if (origin && ALLOWED.includes(origin)) return { ...base, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  return { ...base, Vary: 'Origin' };
}

// ── CACHÉ ───────────────────────────────────────────────────────────────────
// Los reportes MSO se generan una vez al día: 60 s de caché no deja ver datos
// viejos, solo evita repetir la misma consulta. Peticiones idénticas simultáneas
// comparten una sola llamada saliente.
const cache    = new Map();
const inFlight = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now > v.expires) cache.delete(k);
}, CACHE_TTL_MS).unref();

function fetchMso(remotePath, query) {
  const u = new URL(MSO_BASE + remotePath + (query ? '?' + query : ''));
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'x-api-key': MSO_KEY, Accept: 'application/json' } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Timeout de ${TIMEOUT_MS} ms consultando la API MSO`)));
    req.on('error', reject);
    req.end();
  });
}

async function proxyMso(req, res, remotePath, query, noCache) {
  const key  = remotePath + '?' + query;
  const send = (status, body, tag) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': tag, ...corsHeaders(req) });
    res.end(body);
  };

  if (!noCache) {
    const hit = cacheGet(key);
    if (hit) return send(hit.status, hit.body, 'HIT');
  }

  try {
    let p = inFlight.get(key);
    const shared = Boolean(p);
    if (!p) {
      p = fetchMso(remotePath, query).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    const { status, body } = await p;
    if (status === 200) cache.set(key, { expires: Date.now() + CACHE_TTL_MS, status, body });
    send(status, body, shared ? 'COALESCED' : 'MISS');
  } catch (e) {
    send(502, JSON.stringify({ ok: false, error: e.message }), 'ERROR');
  }
}

// ── SERVIDOR ────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
  if (req.method !== 'GET')     return json(405, { ok: false, error: 'Solo GET' });

  if (pathname === '/' || pathname === '/api/health') {
    return json(200, {
      ok: true, service: 'mso-api-proxy', source: MSO_BASE,
      cache: { entries: cache.size, ttl_ms: CACHE_TTL_MS }, now: new Date().toISOString(),
    });
  }

  const remote = msoTarget(pathname);
  if (!remote) return json(404, { ok: false, error: 'Ruta no encontrada' });

  // "Actualizar datos" en el dashboard manda ?refresh=1 para saltarse el caché.
  const q = parsed.searchParams;
  const noCache = q.has('refresh');
  q.delete('refresh');
  proxyMso(req, res, remote, q.toString(), noCache);
}).listen(PORT, HOST, () => {
  console.log(`MSO API proxy escuchando en http://localhost:${PORT}`);
  console.log(`Fuente: ${MSO_BASE}  ·  caché: ${CACHE_TTL_MS} ms  ·  orígenes: ${ALLOWED.join(', ')}`);
});
