// Datos de la cuenta propia: consulta, cambio de correo o teléfono con NIP de
// confirmación, y catálogo de motivos de cancelación.
const bcrypt = require("bcrypt");
const { decryptSensitiveValue, encryptSensitiveValue, hashPhone } = require("./config");
const { requireSession, createRateLimiter } = require("./middleware");
const { checkCode, issueCode } = require("./codes");
const { sendMail } = require("./email");
const { logEvent } = require("./routes-account");

const CHANGE_MINUTES = 10;
const PURPOSES = { correo: "CAMBIO_CORREO", telefono: "CAMBIO_TELEFONO" };
const MESSAGES = {
  invalid: "El NIP no es correcto.",
  expired: "El NIP expiró. Vuelve a solicitar el cambio.",
  locked: "Agotaste los intentos. Vuelve a solicitar el cambio.",
  missing: "No tienes un cambio pendiente de confirmar."
};

const changeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos. Espera unos minutos."
});

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function registerPerfilRoutes(app, pool) {
  app.get("/api/cuenta", requireSession, async (request, response) => {
    const [rows] = await pool.execute(
      "SELECT nombre_completo, correo, telefono_cifrado, fecha_nacimiento FROM usuario WHERE id_usuario = ?",
      [request.session.user.id]
    );
    const user = rows[0];
    if (!user) return response.status(404).json({ message: "No se encontró la cuenta." });
    const phone = decryptSensitiveValue(user.telefono_cifrado);
    return response.json({
      nombre_completo: user.nombre_completo,
      correo: user.correo,
      telefono_ultimos_digitos: phone.slice(-4),
      fecha_nacimiento: user.fecha_nacimiento
    });
  });

  app.get("/api/motivos-cancelacion", requireSession, async (request, response) => {
    const [reasons] = await pool.execute("SELECT id_motivo AS id, nombre FROM cat_motivo_cancelacion ORDER BY id_motivo");
    return response.json({ reasons });
  });

  // Paso 1: valida la contraseña y envía un NIP. El cambio no se guarda hasta confirmarlo.
  app.post("/api/cuenta/editar", requireSession, changeLimiter, async (request, response) => {
    const type = String(request.body.tipo || "");
    const password = request.body.password;
    const userId = request.session.user.id;
    if (!PURPOSES[type]) {
      return response.status(400).json({ message: "Elige qué dato quieres cambiar." });
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return response.status(400).json({ message: "Escribe tu contraseña actual." });
    }
    try {
      const [rows] = await pool.execute(
        "SELECT correo, password_hash FROM usuario WHERE id_usuario = ?",
        [userId]
      );
      const user = rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return response.status(403).json({ message: "La contraseña actual no es correcta. No se guardaron cambios." });
      }

      let value;
      let destination;
      let sendTo;
      if (type === "correo") {
        value = String(request.body.valor || "").trim().toLowerCase();
        if (!isValidEmail(value)) {
          return response.status(400).json({ message: "Escribe un correo electrónico válido." });
        }
        const [taken] = await pool.execute("SELECT 1 FROM usuario WHERE correo = ? AND id_usuario <> ?", [value, userId]);
        if (taken.length > 0) {
          return response.status(409).json({ message: "Ese correo ya está registrado." });
        }
        destination = value;
        sendTo = value;
      } else {
        value = String(request.body.valor || "").replace(/\D/g, "");
        if (!/^\d{10}$/.test(value)) {
          return response.status(400).json({ message: "El teléfono debe tener 10 dígitos." });
        }
        const [taken] = await pool.execute("SELECT 1 FROM usuario WHERE telefono_hash = ? AND id_usuario <> ?", [hashPhone(value), userId]);
        if (taken.length > 0) {
          return response.status(409).json({ message: "Ese teléfono ya está registrado." });
        }
        destination = hashPhone(value);
        sendTo = user.correo;
      }

      const code = await issueCode(pool, userId, PURPOSES[type], destination, CHANGE_MINUTES);
      await sendMail({
        to: sendTo,
        subject: "Confirma el cambio de tus datos en CUIDARED",
        text: `Tu NIP para confirmar el cambio es ${code}. Vence en ${CHANGE_MINUTES} minutos. Si no fuiste tú, cambia tu contraseña.`
      });
      request.session.pendingCambio = { purpose: PURPOSES[type], type, value };
      return response.json({
        message: type === "correo"
          ? "Enviamos un NIP al nuevo correo. Escríbelo para confirmar el cambio."
          : "Enviamos un NIP a tu correo actual para confirmar el cambio de teléfono."
      });
    } catch (error) {
      console.error("Error al solicitar cambio de datos:", error);
      return response.status(500).json({ message: "No fue posible solicitar el cambio." });
    }
  });

  // Paso 2: confirma el NIP y guarda el cambio.
  app.post("/api/cuenta/editar/confirmar", requireSession, changeLimiter, async (request, response) => {
    const pending = request.session.pendingCambio;
    const userId = request.session.user.id;
    if (!pending) {
      return response.status(409).json({ message: MESSAGES.missing });
    }
    const code = String(request.body.nip || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      return response.status(400).json({ message: "El NIP debe tener 6 dígitos." });
    }
    const status = await checkCode(pool, userId, pending.purpose, code);
    if (status !== "ok") {
      return response.status(409).json({ message: MESSAGES[status] || MESSAGES.missing });
    }
    try {
      if (pending.type === "correo") {
        await pool.execute("UPDATE usuario SET correo = ? WHERE id_usuario = ?", [pending.value, userId]);
      } else {
        await pool.execute(
          "UPDATE usuario SET telefono_cifrado = ?, telefono_hash = ? WHERE id_usuario = ?",
          [encryptSensitiveValue(pending.value), hashPhone(pending.value), userId]
        );
      }
      await logEvent(pool, userId, "DATOS_EDITADOS", userId, { dato: pending.type });
      delete request.session.pendingCambio;
      return response.json({ message: pending.type === "correo" ? "Correo actualizado." : "Teléfono actualizado." });
    } catch (error) {
      if (error.code === "23505") {
        return response.status(409).json({ message: "Ese dato ya está registrado por otra cuenta." });
      }
      console.error("Error al guardar cambio de datos:", error);
      return response.status(500).json({ message: "No fue posible guardar el cambio." });
    }
  });
}

module.exports = { registerPerfilRoutes };
