// Middleware: funciones que se ejecutan antes de llegar al controlador de una ruta.
const { redirectWithMessage, HOME_BY_ROLE, realtimeConnectSource } = require("./config");
const { disconnectUser } = require("./realtime");

// Convierte nombres antiguos del catálogo de roles al valor que usan las rutas.
function normalizeRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "prestador") return "prestador";
  if (normalizedRole === "solicitante" || normalizedRole === "buscador") return "solicitante";
  if (normalizedRole === "administrador" || normalizedRole === "administrador principal") return "administrador";
  return "";
}

// Nombre legible de cada rol para los mensajes de error.
const ROLE_LABELS = { solicitante: "solicitante", prestador: "prestador", administrador: "administrador" };

// Confirma que la petición pertenezca a una sesión iniciada.
function requireSession(request, response, next) {
  if (!request.session.user) {
    return response.status(401).json({ message: "Debes iniciar sesión para continuar." });
  }
  const normalizedRole = normalizeRole(request.session.user.role);
  if (normalizedRole) {
    request.session.user.role = normalizedRole;
  }
  next();
}

// Confirma que la sesión tenga el rol solicitado, como solicitante o prestador.
function requireRole(role) {
  return (request, response, next) => {
    if (!request.session.user) {
      return response.status(401).json({ message: "Debes iniciar sesión para continuar." });
    }
    if (normalizeRole(request.session.user.role) !== role) {
      return response.status(403).json({
        message: `Esta operación requiere una cuenta de ${ROLE_LABELS[role] || "otro tipo"}.`
      });
    }
    next();
  };
}

// Solo permite la operación al Administrador principal (requiere una sesión de administrador
// con el indicador principal, que se fija al completar el TOTP).
function requirePrincipal(request, response, next) {
  const sessionUser = request.session.user;
  if (!sessionUser || normalizeRole(sessionUser.role) !== "administrador" || !sessionUser.principal) {
    return response.status(403).json({ message: "Esta operación requiere una cuenta de administrador principal." });
  }
  next();
}

// Mientras un administrador tenga la contraseña temporal, solo puede cambiarla.
function requirePasswordChangeFirst(request, response, next) {
  const user = request.session.user;
  if (!user || !user.mustChange) return next();
  const allowed = ["/auth/cambiar-contrasena.html", "/api/cuenta/cambiar-contrasena", "/api/logout", "/api/session"];
  const isAsset = ["/js/", "/CSS/", "/img/"].some((prefix) => request.path.startsWith(prefix));
  if (allowed.includes(request.path) || isAsset) return next();
  if (request.path.startsWith("/api/")) {
    return response.status(403).json({ message: "Debes cambiar tu contraseña temporal antes de continuar." });
  }
  return response.redirect("/auth/cambiar-contrasena.html");
}

// Protege las páginas HTML para que cada rol entre únicamente a su módulo.
// Sin sesión se va al inicio de sesión. Con sesión pero de otro rol, se va al inicio
// de su propio módulo (no al login, que daría la impresión de que la sesión se perdió).
// Las páginas marcadas con "*" solo piden que exista una sesión, sin importar el rol.
const PROTECTED_PAGES = {
  "/solicitante/solicitar-servicio.html": "solicitante",
  "/solicitante/cancelar.html": "solicitante",
  "/prestador/servicios.html": "prestador",
  "/prestador/registrar-vehiculo.html": "prestador",
  "/admin/usuarios.html": "administrador",
  "/admin/gestion.html": "administrador",
  "/admin/reportes.html": "administrador",
  "/cuenta/editar.html": "*"
};

function protectModulePages(request, response, next) {
  const requiredRole = PROTECTED_PAGES[request.path];
  if (!requiredRole) return next();

  const sessionUser = request.session.user;
  if (!sessionUser) return response.redirect("/auth/iniciar-sesion.html");

  const role = normalizeRole(sessionUser.role);
  if (requiredRole === "*" || role === requiredRole) return next();

  // Un rol sin módulo asignado (o desconocido) cae en la página pública, nunca en un bucle.
  return response.redirect(HOME_BY_ROLE[role] || "/Modulo1.html");
}

// Agrega cabeceras que reducen el riesgo de clickjacking, sniffing de contenido
// y ejecución de scripts de otros sitios. Todo el JavaScript del proyecto vive en
// archivos propios, por eso los scripts solo se permiten desde el mismo origen.
function securityHeaders(request, response, next) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'" + (realtimeConnectSource() ? ` ${realtimeConnectSource()}` : "") + "; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

// Cierra la sesión de quien ya no tiene una cuenta activa (borrada, suspendida o
// desactivada por un administrador). Se consulta la BD en cada petición a la API
// para que el cambio de estado tenga efecto inmediato y no al vencer la cookie.
function enforceActiveAccount(pool) {
  return async (request, response, next) => {
    const sessionUser = request.session.user;
    if (!sessionUser || request.path === "/logout") return next();
    try {
      const [rows] = await pool.execute(
        "SELECT id_estado_cuenta FROM usuario WHERE id_usuario = ?",
        [sessionUser.id]
      );
      if (rows.length > 0 && [1, 2].includes(Number(rows[0].id_estado_cuenta))) return next();
      disconnectUser(sessionUser.id);
      return request.session.destroy(() => {
        response.status(401).json({ message: "Tu cuenta ya no está activa." });
      });
    } catch (error) {
      return next(error);
    }
  };
}

// Limita cuántas peticiones puede hacer una misma IP en una ventana de tiempo.
// Se guarda en memoria: es suficiente para una sola instancia del servidor.
function createRateLimiter({ windowMs, max, message, redirectPage }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of hits) {
      if (value.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip;
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count <= max) return next();
    response.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    // Los formularios HTML reciben el mensaje en la página; las llamadas fetch reciben JSON.
    if (redirectPage) return redirectWithMessage(response, redirectPage, "error", message);
    return response.status(429).json({ message });
  };
}

module.exports = {
  requireSession,
  requireRole,
  requirePrincipal,
  requirePasswordChangeFirst,
  protectModulePages,
  securityHeaders,
  enforceActiveAccount,
  createRateLimiter
};
