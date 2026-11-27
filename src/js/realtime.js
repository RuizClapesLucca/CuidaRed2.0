// Notificaciones en tiempo real. El WebSocket comparte el mismo servidor HTTP de
// Express (en Render solo hay un puerto público).
//
// Autenticación en dos vías:
// 1. Ticket (producción): la página entra por Vercel y el socket va directo a Render.
//    Son dominios distintos, así que la cookie de sesión no viaja al socket. El cliente
//    pide un ticket de un solo uso a /api/realtime/ticket (sí viaja con la sesión) y lo
//    presenta al conectarse. El ticket caduca en pocos segundos.
// 2. Cookie de sesión (desarrollo local o acceso directo al mismo dominio).
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { realtimeAllowedOrigins } = require("./config");

const HEARTBEAT_MS = 30000;
const TICKET_TTL_MS = 30000;
const SESSION_ENDED_CODE = 4001; // código privado de WebSocket: la sesión ya no es válida
const TYPES = ["success", "info", "warning", "error"];

const connections = new Map(); // id de usuario -> Set de sockets abiertos
const tickets = new Map();     // ticket -> { userId, expiresAt }

// Crea un ticket aleatorio, de un solo uso, que caduca en TICKET_TTL_MS.
function issueTicket(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  tickets.set(token, { userId: Number(userId), expiresAt: Date.now() + TICKET_TTL_MS });
  return token;
}

// Canjea un ticket. Se borra aunque esté vencido para que nunca se reutilice.
function consumeTicket(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const entry = tickets.get(token);
  tickets.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

// Limpia tickets que nunca se canjearon (por ejemplo, si el socket no llegó a abrirse).
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tickets) {
    if (entry.expiresAt < now) tickets.delete(token);
  }
}, TICKET_TTL_MS).unref();

// Registra un socket bajo su usuario y lo quita del registro al cerrarse.
function track(userId, socket) {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("error", () => {});
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(socket);
  socket.on("close", () => {
    const set = connections.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) connections.delete(userId);
  });
}

// Envía un aviso a todas las pestañas abiertas de un usuario.
function notifyUser(userId, { type = "info", title = "", message = "" } = {}) {
  const set = connections.get(Number(userId));
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({
    type: TYPES.includes(type) ? type : "info",
    title: String(title).slice(0, 120),
    message: String(message).slice(0, 300)
  });
  for (const socket of set) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

// Cierra todas las conexiones de un usuario, por ejemplo al cerrar sesión o
// desactivar la cuenta. El cliente ve el código 4001 y deja de reconectarse.
function disconnectUser(userId) {
  const set = connections.get(Number(userId));
  if (!set) return;
  for (const socket of set) {
    socket.close(SESSION_ENDED_CODE, "Sesión finalizada");
  }
  connections.delete(Number(userId));
}

// Responde con error antes de completar el cambio de protocolo y cierra el socket.
function rejectUpgrade(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// Valida el origen de la página que abre el socket. Un navegador siempre envía
// Origin, así que esto impide que otra web abra el socket con la sesión de la víctima.
// Las peticiones sin Origin (herramientas) pasan y deben autenticarse igualmente.
function isOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const normalized = String(origin).replace(/\/+$/, "").toLowerCase();
  const ownOrigin = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`.toLowerCase();
  return normalized === ownOrigin || realtimeAllowedOrigins.includes(normalized);
}

function attachRealtime(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(request)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    // Si viene un ticket, manda él: debe ser válido o la conexión se rechaza.
    if (url.searchParams.has("ticket")) {
      const userId = consumeTicket(url.searchParams.get("ticket"));
      if (!userId) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => track(userId, ws));
      return;
    }

    // Sin ticket se usa la cookie de sesión, con el mismo middleware de Express.
    const response = new http.ServerResponse(request);
    sessionMiddleware(request, response, () => {
      const user = request.session && request.session.user;
      if (!user) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => track(Number(user.id), ws));
    });
  });

  // Cierra conexiones que dejaron de responder (por ejemplo, pestañas suspendidas).
  const heartbeat = setInterval(() => {
    for (const set of connections.values()) {
      for (const socket of set) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));
}

module.exports = { attachRealtime, notifyUser, disconnectUser, issueTicket };
