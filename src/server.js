const path = require("path");
const express = require("express");
const session = require("express-session");
const pool = require("./js/db");
const { sessionSecret } = require("./js/config");
const { protectModulePages, securityHeaders, enforceActiveAccount } = require("./js/middleware");
const { registerRoutes: registerAuthRoutes } = require("./js/routes-auth");
const { registerSecurityRoutes } = require("./js/routes-seguridad");
const { registerRecoveryRoutes } = require("./js/routes-recuperacion");
const { registerPostulationRoutes } = require("./js/routes-postulaciones");
const { registerReportRoutes } = require("./js/routes-reportes");
const { registerPerfilRoutes } = require("./js/routes-perfil");
const { registerGestionRoutes } = require("./js/routes-gestion");
const { registerRegenerateRoutes } = require("./js/routes-2fa");
const { requirePasswordChangeFirst } = require("./js/middleware");
const { registerRequestRoutes } = require("./js/routes-requests");
const { registerAccountRoutes } = require("./js/routes-account");
const { registerAdminRoutes } = require("./js/routes-admin");

const app = express();
const port = Number(process.env.PORT || 3000);

// Express 4 no captura los errores de las funciones async: si una consulta falla
// fuera de un try/catch, la petición se queda colgada o el proceso se cae. Este
// envoltorio manda esos errores al manejador de errores del final del archivo.
["get", "post", "patch", "put", "delete"].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = (route, ...handlers) => {
    if (handlers.length === 0) return original(route);
    return original(
      route,
      ...handlers.map((handler) =>
        typeof handler === "function"
          ? (request, response, next) => {
              const result = handler(request, response, next);
              if (result && typeof result.catch === "function") result.catch(next);
              return result;
            }
          : handler
      )
    );
  };
});

// Render y Vercel colocan un proxy delante del servidor. Con Vercel mas Render hay
// dos saltos (TRUST_PROXY_HOPS=2); si se entra directo a Render basta con uno.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable("x-powered-by");
app.use(securityHeaders);

// Interpreta formularios y JSON antes de que las rutas reciban sus datos.
// El límite de tamaño evita que alguien sature el servidor con cuerpos enormes.
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "20kb" }));

// Conserva el usuario autenticado entre peticiones.
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    // secure "auto" marca la cookie solo para HTTPS, así sigue funcionando en local.
    cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 86400000 }
  })
);

// Cierra la sesión de cuentas borradas o desactivadas antes de atender la API.
app.use("/api", enforceActiveAccount(pool));

// Un administrador con contraseña temporal solo puede cambiarla.
app.use(requirePasswordChangeFirst);

// Evita que un usuario entre al módulo correspondiente a otro rol.
app.use(protectModulePages);

// Publica las páginas y hojas de estilos estáticas.
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/CSS", express.static(path.join(__dirname, "..", "CSS")));
app.use("/img", express.static(path.join(__dirname, "..", "img")));

// Mantiene las rutas de entrada de la aplicación.
app.get("/", (request, response) => {
  response.sendFile(path.join(__dirname, "..", "Modulo1.html"));
});
app.get("/Modulo1.html", (request, response) => {
  response.sendFile(path.join(__dirname, "..", "Modulo1.html"));
});

// Cada archivo registra sus propias rutas y validaciones.
registerAuthRoutes(app, pool);
registerSecurityRoutes(app, pool);
registerRecoveryRoutes(app, pool);
registerPostulationRoutes(app, pool);
registerReportRoutes(app, pool);
registerPerfilRoutes(app, pool);
registerGestionRoutes(app, pool);
registerRegenerateRoutes(app, pool);
registerRequestRoutes(app, pool);
registerAccountRoutes(app, pool);
registerAdminRoutes(app, pool);

// Cualquier ruta /api que no exista responde en JSON y sin detalles internos.
app.use("/api", (request, response) => {
  response.status(404).json({ message: "Recurso no encontrado." });
});

// Manejo final de errores: se registra el detalle en el servidor y al navegador
// solo se le entrega un mensaje general, sin rutas ni consultas SQL.
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  const status = Number(error.status || error.statusCode) || 500;
  const isClientError = status >= 400 && status < 500;
  if (!isClientError) console.error("Error no controlado:", error);
  const message = status === 413
    ? "Los datos enviados son demasiado grandes."
    : isClientError
      ? "La petición no es válida."
      : "Ocurrió un error inesperado. Intenta de nuevo más tarde.";
  if (request.path.startsWith("/api/")) return response.status(status).json({ message });
  return response.status(status).send(message);
});

// Evita que un error aislado tire todo el servidor.
process.on("unhandledRejection", (reason) => {
  console.error("Promesa rechazada sin manejar:", reason);
});

app.listen(port, () => {
  console.log(`CUIDARED disponible en http://localhost:${port}`);
});
