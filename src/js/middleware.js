// Middleware: funciones que se ejecutan antes de llegar al controlador de una ruta.

// Convierte nombres antiguos del catálogo de roles al valor que usan las rutas.
function normalizeRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "prestador") return "prestador";
  if (normalizedRole === "solicitante" || normalizedRole === "buscador") return "solicitante";
  return "";
}

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
        message: `Esta operación requiere una cuenta de ${role === "solicitante" ? "solicitante" : "prestador"}.`
      });
    }
    next();
  };
}

// Protege las páginas HTML para que cada rol entre únicamente a su módulo.
// Se ejecuta antes de servir el archivo y redirige a login si el rol no coincide.
function protectModulePages(request, response, next) {
  const protectedRoutes = {
    "/solicitante/solicitar-servicio.html": "solicitante",
    "/prestador/servicios.html": "prestador",
    "/prestador/registrar-vehiculo.html": "prestador"
  };
  const requiredRole = protectedRoutes[request.path];
  if (requiredRole && (!request.session.user || normalizeRole(request.session.user.role) !== requiredRole)) {
    return response.redirect("/auth/iniciar-sesion.html");
  }
  next();
}

module.exports = { requireSession, requireRole, protectModulePages };
