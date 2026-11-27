// Rutas del canal en tiempo real: entrega tickets de un solo uso para abrir el WebSocket.
const { requireSession, createRateLimiter } = require("./middleware");
const { issueTicket } = require("./realtime");
const { realtimePublicUrl } = require("./config");

function registerRealtimeRoutes(app) {
  // Cada pestaña pide un ticket al conectarse y al reconectarse; el límite evita abusos.
  const ticketLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: "Demasiadas solicitudes de conexión. Espera un momento."
  });

  // Solo usuarios con sesión reciben un ticket. La URL indica a dónde conectarse
  // (null significa el mismo dominio de la página).
  app.post("/api/realtime/ticket", requireSession, ticketLimiter, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ticket: issueTicket(request.session.user.id),
      url: realtimePublicUrl || null
    });
  });
}

module.exports = { registerRealtimeRoutes };
