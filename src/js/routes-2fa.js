// Regenerar la clave TOTP de un administrador (lo hace el principal). Si el administrador
// también perdió su contraseña, se genera una temporal y debe cambiarla al entrar.
const bcrypt = require("bcrypt");
const { encryptSensitiveValue } = require("./config");
const { requireSession, requirePrincipal, createRateLimiter } = require("./middleware");
const { generateSecret, otpauthUri } = require("./totp");
const { logEvent } = require("./routes-account");
const { sendMail } = require("./email");
const { verifyOwnCode, temporaryPassword } = require("./routes-gestion");

const ROLE_ADMIN = 3;
const ROLE_PRINCIPAL = 4;
const STATE_ACTIVE = 2;

const limiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Demasiados intentos. Espera unos minutos."
});

function registerRegenerateRoutes(app, pool) {
  app.post("/api/admin/administradores/:id/regenerar", requireSession, requirePrincipal, limiter, async (request, response) => {
    const targetId = Number(request.params.id);
    const adminId = request.session.user.id;
    const reason = String(request.body.motivo || "").trim();
    const resetPassword = request.body.restablecer_contrasena === true;
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return response.status(400).json({ message: "El administrador no es válido." });
    }
    if (targetId === adminId) {
      return response.status(409).json({ message: "Tu propia clave se recupera con el script de recuperación, no desde esta pantalla." });
    }
    if (reason.length < 10 || reason.length > 250) {
      return response.status(400).json({ message: "El motivo debe tener entre 10 y 250 caracteres." });
    }
    const check = await verifyOwnCode(pool, adminId, request.body.totp);
    if (!check.ok) return response.status(403).json({ message: check.message });

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [targets] = await connection.execute(
        `SELECT u.correo, u.id_estado_cuenta, u.password_hash,
                EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = ${ROLE_PRINCIPAL}) AS principal,
                EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = ${ROLE_ADMIN}) AS administrador
         FROM usuario u WHERE u.id_usuario = ? FOR UPDATE`,
        [targetId]
      );
      const target = targets[0];
      if (!target || !target.administrador) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró el administrador." });
      }
      if (target.principal) {
        await connection.rollback();
        return response.status(409).json({ message: "Los administradores principales se recuperan con el script de recuperación." });
      }
      if (Number(target.id_estado_cuenta) !== STATE_ACTIVE) {
        await connection.rollback();
        return response.status(409).json({ message: "Solo puedes regenerar la clave de una cuenta activa." });
      }

      const secret = generateSecret();
      const [updated] = await connection.execute(
        `UPDATE totp_administrador
         SET secreto_cifrado = ?, ultimo_codigo_usado = NULL, intentos_fallidos = 0, bloqueado_hasta = NULL
         WHERE id_usuario = ?`,
        [encryptSensitiveValue(secret), targetId]
      );
      if (updated.affectedRows === 0) {
        await connection.execute(
          "INSERT INTO totp_administrador (id_usuario, secreto_cifrado) VALUES (?, ?)",
          [targetId, encryptSensitiveValue(secret)]
        );
      }

      let password = null;
      if (resetPassword) {
        password = temporaryPassword();
        await connection.execute(
          "INSERT INTO historial_contrasena (id_usuario, password_hash) VALUES (?, ?)",
          [targetId, target.password_hash]
        );
        await connection.execute(
          "UPDATE usuario SET password_hash = ?, debe_cambiar_contrasena = TRUE WHERE id_usuario = ?",
          [await bcrypt.hash(password, 12), targetId]
        );
      }
      await logEvent(connection, adminId, "ADMIN_2FA_REGENERADO", targetId, {
        motivo: reason,
        contrasena_restablecida: resetPassword
      });
      await connection.commit();

      sendMail({
        to: target.correo,
        subject: "Tu verificación en dos pasos fue actualizada",
        text: `El administrador principal regeneró tu clave TOTP${resetPassword ? " y tu contraseña" : ""}. Te la entregará en persona; no la compartas por ningún otro medio.`
      });
      return response.json({
        message: "Clave TOTP regenerada. Entrégala en persona; se muestra una sola vez.",
        totp_clave: secret,
        totp_uri: otpauthUri(secret, target.correo),
        temporary_password: password
      });
    } catch (error) {
      await connection.rollback();
      console.error("Error al regenerar 2FA:", error);
      return response.status(500).json({ message: "No fue posible regenerar la clave." });
    } finally {
      connection.release();
    }
  });
}

module.exports = { registerRegenerateRoutes };
