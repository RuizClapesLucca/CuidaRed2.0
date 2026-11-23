// Recuperación de contraseña por correo: se envía un NIP de 15 minutos y, con él,
// se define una contraseña nueva. La respuesta no revela si el correo existe.
const bcrypt = require("bcrypt");
const { redirectWithMessage } = require("./config");
const { createRateLimiter } = require("./middleware");
const { checkCode, sendRecoveryCode } = require("./codes");

const STATE_ACTIVE = 2;
const LOGIN_PAGE = "auth/iniciar-sesion.html";
const REQUEST_PAGE = "auth/recuperar.html";
const RESET_PAGE = "auth/restablecer.html";

const requestLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Demasiadas solicitudes. Intenta más tarde.",
  redirectPage: REQUEST_PAGE
});
const confirmLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Demasiados intentos. Espera unos minutos.",
  redirectPage: RESET_PAGE
});

// Misma regla que el registro: 8 a 72 bytes, al menos una letra y un número.
function isValidNewPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    Buffer.byteLength(password, "utf8") <= 72 &&
    /\p{L}/u.test(password) &&
    /\d/.test(password)
  );
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function registerRecoveryRoutes(app, pool) {
  app.post("/api/recuperar", requestLimiter, async (request, response) => {
    const email = String(request.body.correo || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      return redirectWithMessage(response, REQUEST_PAGE, "error", "Escribe un correo electrónico válido.");
    }
    const [users] = await pool.execute(
      "SELECT id_usuario, id_estado_cuenta FROM usuario WHERE correo = ?",
      [email]
    );
    if (users.length > 0 && Number(users[0].id_estado_cuenta) === STATE_ACTIVE) {
      try {
        await sendRecoveryCode(pool, users[0].id_usuario, email);
      } catch (error) {
        console.error("No fue posible generar el NIP de recuperación:", error);
      }
    }
    // Mismo mensaje exista o no el correo, para no revelar qué cuentas están registradas.
    return redirectWithMessage(
      response,
      RESET_PAGE,
      "success",
      "Si el correo está registrado, te enviamos un NIP. Vence en 15 minutos."
    );
  });

  app.post("/api/recuperar/confirmar", confirmLimiter, async (request, response) => {
    const email = String(request.body.correo || "").trim().toLowerCase();
    const code = String(request.body.nip || "").replace(/\D/g, "");
    const password = request.body.password;
    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return redirectWithMessage(response, RESET_PAGE, "error", "Revisa el correo y el NIP de 6 dígitos.");
    }
    if (!isValidNewPassword(password)) {
      return redirectWithMessage(
        response,
        RESET_PAGE,
        "error",
        "La contraseña debe tener de 8 a 72 caracteres, con al menos una letra y un número."
      );
    }
    if (password !== request.body.confirmar) {
      return redirectWithMessage(response, RESET_PAGE, "error", "Las contraseñas no coinciden.");
    }

    const [users] = await pool.execute(
      "SELECT id_usuario, password_hash, id_estado_cuenta FROM usuario WHERE correo = ?",
      [email]
    );
    if (users.length === 0 || Number(users[0].id_estado_cuenta) !== STATE_ACTIVE) {
      return redirectWithMessage(response, RESET_PAGE, "error", "El NIP no es válido o expiró.");
    }
    const user = users[0];
    const status = await checkCode(pool, user.id_usuario, "RECUPERACION", code);
    const messages = {
      invalid: "El NIP no es correcto.",
      expired: "El NIP expiró. Solicita uno nuevo.",
      locked: "Agotaste los intentos. Solicita un NIP nuevo.",
      missing: "No tienes un NIP activo. Solicita uno nuevo."
    };
    if (status !== "ok") {
      return redirectWithMessage(response, RESET_PAGE, "error", messages[status] || messages.missing);
    }

    // Guarda la contraseña anterior en el historial y desbloquea la cuenta.
    await pool.execute(
      "INSERT INTO historial_contrasena (id_usuario, password_hash) VALUES (?, ?)",
      [user.id_usuario, user.password_hash]
    );
    const newHash = await bcrypt.hash(password, 12);
    await pool.execute(
      "UPDATE usuario SET password_hash = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?",
      [newHash, user.id_usuario]
    );
    return redirectWithMessage(response, LOGIN_PAGE, "success", "Tu contraseña fue actualizada. Ya puedes iniciar sesión.");
  });
}

module.exports = { registerRecoveryRoutes };
