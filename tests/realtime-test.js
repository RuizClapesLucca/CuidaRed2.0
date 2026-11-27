// Prueba de integración: usa los módulos reales del proyecto (realtime, routes-realtime, middleware).
const P = require("path").resolve(__dirname, "..");
process.env.SESSION_SECRET = "test-secret-123456";
process.env.PHONE_HMAC_SECRET = "test-hmac-123456";
process.env.PHONE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.REALTIME_PUBLIC_URL = "wss://cuidared.onrender.com/ws";
process.env.REALTIME_ALLOWED_ORIGINS = "https://app.vercel.app/";

const assert = require("assert");
const http = require("http");
const express = require(P + "/node_modules/express");
const session = require(P + "/node_modules/express-session");
const WebSocket = require(P + "/node_modules/ws");
const { sessionSecret } = require(P + "/src/js/config");
const { attachRealtime, notifyUser, disconnectUser } = require(P + "/src/js/realtime");
const { registerRealtimeRoutes } = require(P + "/src/js/routes-realtime");
const { protectModulePages, securityHeaders } = require(P + "/src/js/middleware");

const app = express();
app.use(securityHeaders);
const sessionMiddleware = session({
  secret: sessionSecret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 86400000 }
});
app.use(sessionMiddleware);
// Inicio de sesión simulado (sin base de datos): fija el usuario en la sesión.
app.get("/test/login", (req, res) => {
  req.session.user = { id: Number(req.query.id), role: req.query.role, name: "Prueba" };
  res.send("ok");
});
app.use(protectModulePages);
app.use(express.static(P + "/public"));
registerRealtimeRoutes(app);
const server = http.createServer(app);
attachRealtime(server, sessionMiddleware);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}
// Abre un socket y resuelve con { ws, opened: true } o rechaza con el código HTTP del rechazo.
function open(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", (e) => reject(e));
  });
}
const nextMessage = (ws) => new Promise((r) => ws.once("message", (d) => r(JSON.parse(d.toString()))));
const nextClose = (ws) => new Promise((r) => ws.once("close", (code) => r(code)));

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}/ws`;

  // Obtiene una cookie de sesión para un usuario simulado.
  async function loginCookie(id, role) {
    const r = await fetch(`${base}/test/login?id=${id}&role=${role}`);
    return r.headers.get("set-cookie").split(";")[0];
  }
  async function ticketFor(cookie) {
    const r = await fetch(`${base}/api/realtime/ticket`, { method: "POST", headers: { Cookie: cookie } });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  }

  await test("CSP incluye el origen WebSocket público", async () => {
    const r = await fetch(`${base}/auth/iniciar-sesion.html`);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /connect-src 'self' wss:\/\/cuidared\.onrender\.com;/);
  });

  await test("Ticket: sin sesión responde 401", async () => {
    const t = await ticketFor("");
    assert.strictEqual(t.status, 401);
  });

  await test("Ticket: con sesión entrega ticket y URL pública", async () => {
    const cookie = await loginCookie(7, "solicitante");
    const t = await ticketFor(cookie);
    assert.strictEqual(t.status, 200);
    assert.match(t.body.ticket, /^[0-9a-f]{64}$/);
    assert.strictEqual(t.body.url, "wss://cuidared.onrender.com/ws");
  });

  await test("WS con ticket válido (origen permitido) recibe aviso dirigido", async () => {
    const cookie = await loginCookie(7, "solicitante");
    const { body } = await ticketFor(cookie);
    const ws = await open(`${wsBase}?ticket=${body.ticket}`, { Origin: "https://app.vercel.app" });
    const msg = nextMessage(ws);
    notifyUser(7, { type: "success", title: "Hola", message: "Aviso de prueba" });
    const data = await msg;
    assert.deepStrictEqual(data, { type: "success", title: "Hola", message: "Aviso de prueba" });
    ws.close();
    await wait(50);
  });

  await test("El ticket es de un solo uso (reutilizarlo responde 401)", async () => {
    const cookie = await loginCookie(7, "solicitante");
    const { body } = await ticketFor(cookie);
    const first = await open(`${wsBase}?ticket=${body.ticket}`, { Origin: "https://app.vercel.app" });
    first.close();
    await wait(50);
    await assert.rejects(open(`${wsBase}?ticket=${body.ticket}`, { Origin: "https://app.vercel.app" }), /HTTP 401/);
  });

  await test("Ticket inválido responde 401 aunque haya cookie", async () => {
    const cookie = await loginCookie(7, "solicitante");
    await assert.rejects(open(`${wsBase}?ticket=falso`, { Origin: "https://app.vercel.app", Cookie: cookie }), /HTTP 401/);
  });

  await test("Origen no permitido responde 403", async () => {
    const cookie = await loginCookie(7, "solicitante");
    const { body } = await ticketFor(cookie);
    await assert.rejects(open(`${wsBase}?ticket=${body.ticket}`, { Origin: "https://evil.example" }), /HTTP 403/);
  });

  await test("Cookie de sesión sin ticket funciona (acceso directo)", async () => {
    const cookie = await loginCookie(9, "prestador");
    const ws = await open(wsBase, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
    const msg = nextMessage(ws);
    notifyUser(9, { type: "info", title: "Directo", message: "x" });
    assert.strictEqual((await msg).title, "Directo");
    ws.close();
    await wait(50);
  });

  await test("Sin ticket ni sesión responde 401", async () => {
    await assert.rejects(open(wsBase, { Origin: "https://app.vercel.app" }), /HTTP 401/);
  });

  await test("Ruta distinta de /ws se rechaza", async () => {
    await assert.rejects(open(`ws://127.0.0.1:${port}/otra`, { Origin: "https://app.vercel.app" }));
  });

  await test("Varias pestañas del mismo usuario reciben el aviso", async () => {
    const cookie = await loginCookie(11, "solicitante");
    const a = await open(wsBase, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
    const b = await open(wsBase, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
    const ma = nextMessage(a), mb = nextMessage(b);
    notifyUser(11, { title: "Dos pestañas" });
    assert.strictEqual((await ma).title, "Dos pestañas");
    assert.strictEqual((await mb).title, "Dos pestañas");
    a.close(); b.close(); await wait(50);
  });

  await test("Un aviso a un usuario sin conexiones no lanza error", async () => {
    notifyUser(999, { title: "nadie" });
  });

  await test("Un aviso no llega a otro usuario", async () => {
    const cookie = await loginCookie(21, "solicitante");
    const ws = await open(wsBase, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
    let received = false;
    ws.on("message", () => { received = true; });
    notifyUser(22, { title: "para otro" });
    await wait(150);
    assert.strictEqual(received, false);
    ws.close(); await wait(50);
  });

  await test("disconnectUser cierra con código 4001 (sesión terminada)", async () => {
    const cookie = await loginCookie(31, "prestador");
    const ws = await open(wsBase, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
    const closed = nextClose(ws);
    disconnectUser(31);
    assert.strictEqual(await closed, 4001);
  });

  await test("Redirección: sin sesión a login; otro rol a su inicio; rol correcto entra", async () => {
    let r = await fetch(`${base}/admin/usuarios.html`, { redirect: "manual" });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get("location"), "/auth/iniciar-sesion.html");

    const prestador = await loginCookie(41, "prestador");
    r = await fetch(`${base}/admin/usuarios.html`, { redirect: "manual", headers: { Cookie: prestador } });
    assert.strictEqual(r.headers.get("location"), "/prestador/servicios.html");

    const admin = await loginCookie(51, "administrador");
    r = await fetch(`${base}/admin/usuarios.html`, { redirect: "manual", headers: { Cookie: admin } });
    assert.strictEqual(r.status, 200);
    r = await fetch(`${base}/admin/gestion.html`, { redirect: "manual", headers: { Cookie: prestador } });
    assert.strictEqual(r.headers.get("location"), "/prestador/servicios.html");
  });

  await test("Redirección: /cuenta/editar.html exige sesión, cualquier rol sirve", async () => {
    let r = await fetch(`${base}/cuenta/editar.html`, { redirect: "manual" });
    assert.strictEqual(r.headers.get("location"), "/auth/iniciar-sesion.html");
    const solicitante = await loginCookie(61, "solicitante");
    r = await fetch(`${base}/cuenta/editar.html`, { redirect: "manual", headers: { Cookie: solicitante } });
    assert.strictEqual(r.status, 200);
  });

  await test("Páginas públicas no redirigen", async () => {
    const r = await fetch(`${base}/auth/iniciar-sesion.html`, { redirect: "manual" });
    assert.strictEqual(r.status, 200);
  });

  server.close();
  for (const [status, name, err] of results) console.log(status, "-", name, err ? `\n     ${err}` : "");
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} pruebas correctas`);
  process.exit(failed ? 1 : 0);
});
