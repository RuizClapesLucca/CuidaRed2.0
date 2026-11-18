const path = require("path");
const express = require("express");
const session = require("express-session");
const pool = require("./js/db");
const { sessionSecret } = require("./js/config");
const { protectModulePages } = require("./js/middleware");
const { registerRoutes: registerAuthRoutes } = require("./js/routes-auth");
const { registerRequestRoutes } = require("./js/routes-requests");

const app = express();
const port = Number(process.env.PORT || 3000);

// Interpreta formularios y JSON antes de que las rutas reciban sus datos.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Conserva el usuario autenticado entre peticiones.
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 86400000 }
  })
);

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
registerRequestRoutes(app, pool);

app.listen(port, () => {
  console.log(`CUIDARED disponible en http://localhost:${port}`);
});
