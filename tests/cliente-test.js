// Ejecuta los scripts del navegador con un DOM simulado mínimo y revisa su lógica.
const fs = require("fs");
const assert = require("assert");
const P = require("path").resolve(__dirname, "..", "public", "js") + "/";

// Elemento simulado: acepta cualquier operación básica de DOM.
function makeEl(attrs = {}) {
  const el = {
    className: "", _text: "", _html: "", hidden: false, children: [], listeners: {}, attrs: { ...attrs },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
    style: { setProperty() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl(); },
    remove() {}, focus() {}
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v; } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = v; } });
  return el;
}

let sockets = [];
let fetchPlan = [];          // respuestas de fetch en orden
let timers = [];             // setTimeout programados (no se ejecutan solos)
globalThis.location = { protocol: "https:", host: "cuidared.onrender.com", hostname: "cuidared.onrender.com", pathname: "/prestador/servicios.html", origin: "https://cuidared.onrender.com" };
globalThis.document = { hidden: false, body: makeEl(), addEventListener() {}, querySelector: () => null,
  querySelectorAll: () => [], createElement: () => makeEl() };
globalThis.window = { addEventListener() {}, location: globalThis.location };
globalThis.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 0; this.ls = {}; sockets.push(this); }
  addEventListener(t, f) { (this.ls[t] ||= []).push(f); }
  emit(t, e = {}) { (this.ls[t] || []).forEach((f) => f(e)); }
};
globalThis.WebSocket.OPEN = 1; globalThis.WebSocket.CONNECTING = 0;
globalThis.fetch = async (url) => {
  const plan = fetchPlan.shift() || { status: 500 };
  return { ok: plan.status >= 200 && plan.status < 300, status: plan.status,
    json: async () => plan.body, headers: { get: () => "" } };
};
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearTimeout = () => {};
globalThis.console.warn = () => {};

const flush = () => new Promise((r) => setImmediate(r));
const load = (name) => new Function(fs.readFileSync(P + name, "utf8"));

(async () => {
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push("PASS - " + name); }
    catch (e) { results.push("FAIL - " + name + "\n     " + e.message); }
  };

  await check("avisos: obtiene ticket y abre WebSocket con el ticket en la URL", async () => {
    sockets = []; timers = [];
    fetchPlan = [{ status: 200, body: { ticket: "T1", url: "wss://cuidared.onrender.com/ws" } }];
    load("notificaciones.js")();
    await flush(); await flush();
    assert.strictEqual(sockets.length, 1);
    assert.strictEqual(sockets[0].url, "wss://cuidared.onrender.com/ws?ticket=T1");
  });

  await check("avisos: al recibir un mensaje muestra el aviso (sin errores)", async () => {
    const s = sockets[0];
    s.emit("open");
    s.emit("message", { data: JSON.stringify({ type: "success", title: "Hola", message: "x" }) });
    assert.ok(typeof window.cuidaredToast === "function");
  });

  await check("avisos: sin sesión (401) no abre conexión", async () => {
    // Carga en un contexto limpio simulando otra página.
    sockets = []; timers = [];
    delete globalThis.window.__cuidaredRealtimeInit;
    fetchPlan = [{ status: 401, body: { message: "no" } }];
    load("notificaciones.js")();
    await flush(); await flush();
    assert.strictEqual(sockets.length, 0);
  });

  await check("avisos: error de red programa reconexión con espera creciente", async () => {
    sockets = []; timers = [];
    delete globalThis.window.__cuidaredRealtimeInit;
    fetchPlan = [{ status: 500 }];
    load("notificaciones.js")();
    await flush(); await flush();
    assert.strictEqual(sockets.length, 0);
    assert.ok(timers.length >= 1, "debe programar un reintento");
    assert.strictEqual(timers[0].ms, 1000);
  });

  await check("avisos: cierre normal (1006) programa reconexión", async () => {
    sockets = []; timers = [];
    delete globalThis.window.__cuidaredRealtimeInit;
    fetchPlan = [{ status: 200, body: { ticket: "A", url: "wss://cuidared.onrender.com/ws" } }];
    load("notificaciones.js")();
    await flush(); await flush();
    const s = sockets[0];
    s.readyState = 3;
    s.emit("close", { code: 1006 });
    assert.ok(timers.length >= 1, "debe programar reconexión");
  });

  await check("avisos: cierre 4001 no programa reconexión", async () => {
    sockets = []; timers = [];
    delete globalThis.window.__cuidaredRealtimeInit;
    fetchPlan = [{ status: 200, body: { ticket: "B", url: "wss://cuidared.onrender.com/ws" } }];
    load("notificaciones.js")();
    await flush(); await flush();
    const s = sockets[0];
    timers = [];
    s.emit("close", { code: 4001 });
    assert.strictEqual(timers.length, 0);
  });

  await check("sesion-nav: se ejecuta sin errores con y sin sesión", async () => {
    fetchPlan = [{ status: 200, body: { authenticated: true, user: { id: 1 }, home: "/admin/usuarios.html" } }];
    load("sesion-nav.js")();
    await flush(); await flush();
    fetchPlan = [{ status: 200, body: { authenticated: false, user: null, home: null } }];
    load("sesion-nav.js")();
    await flush(); await flush();
  });

  console.log(results.join("\n"));
  console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} correctas`);
})();
