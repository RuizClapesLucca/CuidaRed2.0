// Rutas de seguridad: verificación de registro con NIP y segundo paso de inicio
// de sesión (TOTP) para administradores. El estado pendiente vive en la sesión.
const { redirectWithMessage, decryptSensitiveValue } = require("./config");
const { createRateLimiter } = require("./middleware");
const { checkCode, sendRegistrationCode } = require("./codes");
const { verifyTotp } = require("./totp");

const STATE_PENDING = 1;
const STATE_ACTIVE = 2;
const TOTP_MAX_ATTEMPTS = 3;
const TOTP_LOCK_MINUTES = 15;

const LOGIN_PAGE = "auth/iniciar-sesion.html";
const NIP_PAGE = "auth/verificar-nip.html";
const TOTP_PAGE = "auth/verificar-totp.html";

const verifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Demasiados intentos. Espera unos minutos.",
  redirectPage: NIP_PAGE
});
const resendLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Espera unos minutos antes de pedir otro NIP.",
  redirectPage: NIP_PAGE
});
const totpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Demasiados intentos. Espera unos minutos.",
  redirectPage: TOTP_PAGE
});

function registerSecurityRoutes(app, pool) {
  // Confirma el NIP del registro y activa la cuenta.
  app.post("/api/registro/verificar", verifyLimiter, async (request, response) => {
    const userId = request.session.pendingVerificationUserId;
    if (!userId) {
      return redirectWithMessage(response, LOGIN_PAGE, "error", "No hay un registro pendiente de verificar.");
    }
    const code = String(request.body.nip || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      return redirectWithMessage(response, NIP_PAGE, "error", "El NIP debe tener 6 dígitos.");
    }
    const status = await checkCode(pool, userId, "REGISTRO", code);
    const messages = {
      invalid: "El NIP no es correcto.",
      expired: "El NIP expiró. Solicita uno nuevo.",
      locked: "Agotaste los intentos. Solicita un NIP nuevo.",
      missing: "No tienes un NIP activo. Solicita uno nuevo."
    };
    if (status !== "ok") {
      return redirectWithMessage(response, NIP_PAGE, "error", messages[status] || messages.missing);
    }
    await pool.execute(
      "UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ? AND id_estado_cuenta = ?",
      [STATE_ACTIVE, userId, STATE_PENDING]
    );
    const [roles] = await pool.execute("SELECT id_rol FROM usuario_rol WHERE id_usuario = ?", [userId]);
    delete request.session.pendingVerificationUserId;
    request.session.registrationRole = roles.some((item) => Number(item.id_rol) === 2)
      ? "prestador"
      : "solicitante";
    return redirectWithMessage(response, "auth/registro-exitoso.html", "success", "Cuenta verificada.");
  });

  // Envía un NIP nuevo; invalida el anterior.
  app.post("/api/registro/reenviar", resendLimiter, async (request, response) => {
    const userId = request.session.pendingVerificationUserId;
    if (!userId) {
      return redirectWithMessage(response, LOGIN_PAGE, "error", "No hay un registro pendiente de verificar.");
    }
    const [users] = await pool.execute(
      "SELECT correo, id_estado_cuenta FROM usuario WHERE id_usuario = ?",
      [userId]
    );
    if (users.length === 0 || Number(users[0].id_estado_cuenta) !== STATE_PENDING) {
      delete request.session.pendingVerificationUserId;
      return redirectWithMessage(response, LOGIN_PAGE, "error", "Esta cuenta ya fue verificada o no está disponible.");
    }
    await sendRegistrationCode(pool, userId, users[0].correo);
    return redirectWithMessage(response, NIP_PAGE, "success", "Te enviamos un nuevo NIP a tu correo.");
  });

  // Segundo paso del inicio de sesión de administradores.
  app.post("/api/login/totp", totpLimiter, async (request, response) => {
    const pending = request.session.pendingAdmin;
    if (!pending) {
      return redirectWithMessage(response, LOGIN_PAGE, "error", "Tu verificación expiró. Inicia sesión de nuevo.");
    }
    const code = String(request.body.codigo || "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      return redirectWithMessage(response, TOTP_PAGE, "error", "El código debe tener 6 dígitos.");
    }
    const [rows] = await pool.execute(
      `SELECT t.secreto_cifrado, t.ultimo_codigo_usado,
              (t.bloqueado_hasta IS NOT NULL AND t.bloqueado_hasta > (NOW() AT TIME ZONE 'UTC')) AS bloqueado,
              u.nombre_completo, u.id_estado_cuenta
       FROM totp_administrador t
       JOIN usuario u ON u.id_usuario = t.id_usuario
       WHERE t.id_usuario = ?`,
      [pending.id]
    );
    const row = rows[0];
    if (!row || Number(row.id_estado_cuenta) !== STATE_ACTIVE) {
      delete request.session.pendingAdmin;
      return redirectWithMessage(response, LOGIN_PAGE, "error", "Esta cuenta no está disponible.");
    }
    if (row.bloqueado) {
      return redirectWithMessage(response, TOTP_PAGE, "error", `Demasiados intentos. Espera ${TOTP_LOCK_MINUTES} minutos.`);
    }

    const secret = decryptSensitiveValue(row.secreto_cifrado);
    const match = verifyTotp(secret, code);
    // Un código ya usado no sirve de nuevo dentro de su ventana (evita reutilización).
    if (!match || match.code === String(row.ultimo_codigo_usado || "").trim()) {
      await pool.execute(
        `UPDATE totp_administrador
         SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= ?::int THEN 0 ELSE intentos_fallidos + 1 END,
             bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= ?::int
               THEN (NOW() AT TIME ZONE 'UTC') + make_interval(mins => ?::int)
               ELSE bloqueado_hasta END
         WHERE id_usuario = ?`,
        [TOTP_MAX_ATTEMPTS, TOTP_MAX_ATTEMPTS, TOTP_LOCK_MINUTES, pending.id]
      );
      return redirectWithMessage(response, TOTP_PAGE, "error", "Código incorrecto o ya utilizado. Usa el código vigente de tu app.");
    }

    await pool.execute(
      "UPDATE totp_administrador SET ultimo_codigo_usado = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?",
      [match.code, pending.id]
    );
    await new Promise((resolve, reject) => {
      request.session.regenerate((error) => (error ? reject(error) : resolve()));
    });
    const [flags] = await pool.execute(
      "SELECT debe_cambiar_contrasena FROM usuario WHERE id_usuario = ?",
      [pending.id]
    );
    request.session.user = {
      id: pending.id,
      name: row.nombre_completo,
      role: "administrador",
      principal: Boolean(pending.principal),
      mustChange: Boolean(flags[0] && flags[0].debe_cambiar_contrasena)
    };
    if (request.session.user.mustChange) return response.redirect("/auth/cambiar-contrasena.html");
    return response.redirect("/admin/usuarios.html");
  });
}

module.exports = { registerSecurityRoutes };
