// Gestión de administradores (solo Administrador principal, con TOTP propio),
// métricas del sistema, reportes técnicos y cambio de contraseña temporal.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { decryptSensitiveValue, encryptSensitiveValue, hashPhone, admin2faEnabled } = require("./config");
const { requireSession, requireRole, requirePrincipal, createRateLimiter } = require("./middleware");
const { generateSecret, otpauthUri, verifyTotp } = require("./totp");
const { logEvent } = require("./routes-account");
const { sendMail } = require("./email");

const ROLE_ADMIN = 3;
const ROLE_PRINCIPAL = 4;
const STATE_ACTIVE = 2;
const STATE_DISABLED = 6;
const STATE_DELETED = 5;
const TOTP_MAX_ATTEMPTS = 3;
const METRICS_MAX_DAYS = 730;
const TICKETS_MAX_DAYS = 365;

const totpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Demasiados intentos. Espera unos minutos."
});

function isValidDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(text || "")) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime());
}

function daysBetween(from, to) {
  return (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
}

// Rango por defecto: últimos 30 días hasta hoy (UTC).
function readRange(query, maxDays) {
  const until = query.hasta ? String(query.hasta) : new Date().toISOString().slice(0, 10);
  let since = query.desde ? String(query.desde) : null;
  if (!since) {
    const date = new Date(`${until}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 30);
    since = date.toISOString().slice(0, 10);
  }
  if (!isValidDate(since) || !isValidDate(until) || since > until) {
    return { error: "El rango de fechas no es válido." };
  }
  if (daysBetween(since, until) > maxDays) {
    return { error: `El rango máximo de consulta es de ${Math.round(maxDays / 30)} meses.` };
  }
  return { since, until };
}

// Verifica el código TOTP del administrador que está operando, con protección contra reutilización.
async function verifyOwnCode(pool, adminId, rawCode) {
  // Con el 2FA desactivado no se pide código; el resto de controles siguen igual.
  if (!admin2faEnabled) return { ok: true };
  const code = String(rawCode || "").replace(/\s/g, "");
  const [rows] = await pool.execute(
    `SELECT secreto_cifrado, ultimo_codigo_usado,
            (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > (NOW() AT TIME ZONE 'UTC')) AS bloqueado
     FROM totp_administrador WHERE id_usuario = ?`,
    [adminId]
  );
  const row = rows[0];
  if (!row) return { ok: false, message: "Tu cuenta no tiene 2FA configurado." };
  if (row.bloqueado) return { ok: false, message: "Demasiados intentos de código. Espera 15 minutos." };
  const match = verifyTotp(decryptSensitiveValue(row.secreto_cifrado), code);
  if (!match || match.code === String(row.ultimo_codigo_usado || "").trim()) {
    await pool.execute(
      `UPDATE totp_administrador
       SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= ?::int THEN 0 ELSE intentos_fallidos + 1 END,
           bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= ?::int
             THEN (NOW() AT TIME ZONE 'UTC') + INTERVAL '15 minutes' ELSE bloqueado_hasta END
       WHERE id_usuario = ?`,
      [TOTP_MAX_ATTEMPTS, TOTP_MAX_ATTEMPTS, adminId]
    );
    return { ok: false, message: "Código TOTP incorrecto o ya utilizado." };
  }
  await pool.execute(
    "UPDATE totp_administrador SET ultimo_codigo_usado = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?",
    [match.code, adminId]
  );
  return { ok: true };
}

// Genera una contraseña temporal con letras y dígitos (cumple la política de registro).
function temporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
  let letters = "";
  for (const byte of crypto.randomBytes(8)) letters += alphabet[byte % alphabet.length];
  return `${letters}${crypto.randomInt(10, 99)}`;
}

function registerGestionRoutes(app, pool) {
  app.get("/api/admin/administradores", requireSession, requireRole("administrador"), async (request, response) => {
    const [rows] = await pool.execute(
      `SELECT u.id_usuario AS id, u.nombre_completo, u.correo, u.id_estado_cuenta, e.nombre AS estado,
              EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = ${ROLE_PRINCIPAL}) AS principal,
              EXISTS (SELECT 1 FROM totp_administrador t WHERE t.id_usuario = u.id_usuario) AS con_2fa,
              u.debe_cambiar_contrasena
       FROM usuario u
       JOIN cat_estado_cuenta e ON e.id_estado_cuenta = u.id_estado_cuenta
       WHERE EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol IN (${ROLE_ADMIN}, ${ROLE_PRINCIPAL}))
       ORDER BY u.id_usuario`
    );
    return response.json({ admins: rows });
  });

  // Crea un administrador con contraseña temporal y TOTP. El principal confirma con su propio código.
  app.post("/api/admin/administradores", requireSession, requirePrincipal, totpLimiter, async (request, response) => {
    const name = String(request.body.nombre || "").trim().replace(/\s+/g, " ");
    const email = String(request.body.correo || "").trim().toLowerCase();
    const phone = String(request.body.telefono || "").replace(/\D/g, "");
    const birthDate = String(request.body.fecha_nacimiento || "");
    if (name.length < 3 || name.length > 120 || !/^\p{L}[\p{L}\s.'-]*$/u.test(name)) {
      return response.status(400).json({ message: "Escribe el nombre completo usando solo letras." });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response.status(400).json({ message: "Escribe un correo válido." });
    }
    if (!/^\d{10}$/.test(phone)) {
      return response.status(400).json({ message: "El teléfono debe tener 10 dígitos." });
    }
    if (!isValidDate(birthDate) || birthDate > new Date().toISOString().slice(0, 10)) {
      return response.status(400).json({ message: "La fecha de nacimiento no es válida." });
    }
    const check = await verifyOwnCode(pool, request.session.user.id, request.body.totp);
    if (!check.ok) return response.status(403).json({ message: check.message });

    const [taken] = await pool.execute(
      "SELECT 1 FROM usuario WHERE correo = ? OR telefono_hash = ?",
      [email, hashPhone(phone)]
    );
    if (taken.length > 0) {
      return response.status(409).json({ message: "Ya existe una cuenta con ese correo o teléfono." });
    }
    const password = temporaryPassword();
    const secret = generateSecret();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [inserted] = await connection.execute(
        `INSERT INTO usuario
           (nombre_completo, nombre_pila, correo, password_hash, telefono_cifrado, telefono_hash,
            id_sexo, fecha_nacimiento, id_estado_cuenta, debe_cambiar_contrasena)
         VALUES (?, ?, ?, ?, ?, ?, 4, ?, ?, TRUE)`,
        [name, name.split(" ")[0], email, await bcrypt.hash(password, 12), encryptSensitiveValue(phone),
          hashPhone(phone), birthDate, STATE_ACTIVE]
      );
      const adminId = inserted.insertId;
      await connection.execute("INSERT INTO usuario_rol (id_usuario, id_rol) VALUES (?, ?)", [adminId, ROLE_ADMIN]);
      await connection.execute(
        "INSERT INTO totp_administrador (id_usuario, secreto_cifrado) VALUES (?, ?)",
        [adminId, encryptSensitiveValue(secret)]
      );
      await logEvent(connection, request.session.user.id, "ADMIN_CREADO", adminId, { correo: email });
      await connection.commit();
      const uri = otpauthUri(secret, email);
      sendMail({
        to: email,
        subject: "Tu cuenta de administrador de CUIDARED",
        text: `Se creó tu cuenta de administrador. Contraseña temporal: ${password}\nAl entrar por primera vez deberás cambiarla. Tu clave TOTP te la entregará en persona el administrador principal; no se envía por correo.`
      });
      return response.status(201).json({
        message: "Administrador creado. Entrega la contraseña temporal y la clave TOTP en persona; se muestran una sola vez.",
        temporary_password: password,
        totp_clave: secret,
        totp_uri: uri
      });
    } catch (error) {
      await connection.rollback();
      if (error.code === "23505") {
        return response.status(409).json({ message: "Ya existe una cuenta con ese correo o teléfono." });
      }
      console.error("Error al crear administrador:", error);
      return response.status(500).json({ message: "No fue posible crear el administrador." });
    } finally {
      connection.release();
    }
  });

  // Inhabilita o elimina (borrado lógico) a un administrador.
  for (const [route, newState, label] of [
    ["inhabilitar", STATE_DISABLED, "inhabilitado"],
    ["eliminar", STATE_DELETED, "eliminado"]
  ]) {
    app.post(`/api/admin/administradores/:id/${route}`, requireSession, requirePrincipal, totpLimiter, async (request, response) => {
      const targetId = Number(request.params.id);
      const adminId = request.session.user.id;
      const reason = String(request.body.motivo || "").trim();
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return response.status(400).json({ message: "El administrador no es válido." });
      }
      if (reason.length < 10 || reason.length > 250) {
        return response.status(400).json({ message: "El motivo debe tener entre 10 y 250 caracteres." });
      }
      if (targetId === adminId) {
        return response.status(409).json({ message: "No es posible inhabilitar ni eliminar la cuenta propia." });
      }
      const check = await verifyOwnCode(pool, adminId, request.body.totp);
      if (!check.ok) return response.status(403).json({ message: check.message });

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [targets] = await connection.execute(
          `SELECT u.id_estado_cuenta,
                  EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = ${ROLE_PRINCIPAL}) AS principal,
                  EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = ${ROLE_ADMIN}) AS administrador
           FROM usuario u WHERE u.id_usuario = ? FOR UPDATE`,
          [targetId]
        );
        const target = targets[0];
        if (!target || !target.administrador && !target.principal) {
          await connection.rollback();
          return response.status(404).json({ message: "No se encontró el administrador." });
        }
        if (Number(target.id_estado_cuenta) === newState) {
          await connection.rollback();
          return response.status(409).json({ message: `La cuenta ya está ${label}.` });
        }
        if (target.principal) {
          const [others] = await connection.execute(
            `SELECT COUNT(*) AS total FROM usuario u
             JOIN usuario_rol r ON r.id_usuario = u.id_usuario AND r.id_rol = ${ROLE_PRINCIPAL}
             WHERE u.id_usuario <> ? AND u.id_estado_cuenta = ?`,
            [targetId, STATE_ACTIVE]
          );
          if (Number(others[0].total) === 0) {
            await connection.rollback();
            return response.status(409).json({
              message: "No es posible dejar el sistema sin un Administrador principal activo."
            });
          }
        }
        await connection.execute("UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ?", [newState, targetId]);
        await logEvent(connection, adminId, `ADMIN_${label.toUpperCase()}`, targetId, { motivo: reason });
        await connection.commit();
        return response.json({ message: `Administrador ${label}.` });
      } catch (error) {
        await connection.rollback();
        console.error("Error al cambiar estado de administrador:", error);
        return response.status(500).json({ message: "No fue posible completar la acción." });
      } finally {
        connection.release();
      }
    });
  }

  // Métricas: servicios terminados, registros, incidencias. Máximo 24 meses.
  app.get("/api/admin/metricas", requireSession, requireRole("administrador"), async (request, response) => {
    const range = readRange(request.query, METRICS_MAX_DAYS);
    if (range.error) return response.status(400).json({ message: range.error });
    const municipality = String(request.query.municipio || "").trim();
    if (municipality.length > 80) {
      return response.status(400).json({ message: "El municipio no es válido." });
    }
    try {
      const zoneFilter = municipality ? " AND z.municipio = ?" : "";
      const zoneParams = municipality ? [municipality] : [];
      const [finished] = await pool.execute(
        `SELECT TO_CHAR(p.fecha_terminado, 'YYYY-MM') AS mes, COUNT(*) AS total
         FROM peticion p JOIN cat_zona z ON z.id_zona = p.id_zona
         WHERE p.id_estado_peticion = 3
           AND p.fecha_terminado >= ?::date AND p.fecha_terminado < (?::date + INTERVAL '1 day')${zoneFilter}
         GROUP BY 1 ORDER BY 1`,
        [range.since, range.until, ...zoneParams]
      );
      const [reports] = await pool.execute(
        `SELECT TO_CHAR(r.fecha_reporte, 'YYYY-MM') AS mes, COUNT(*) AS total
         FROM reporte r
         JOIN servicio s ON s.id_servicio = r.id_servicio
         JOIN peticion p ON p.id_peticion = s.id_peticion
         JOIN cat_zona z ON z.id_zona = p.id_zona
         WHERE r.fecha_reporte >= ?::date AND r.fecha_reporte < (?::date + INTERVAL '1 day')${zoneFilter}
         GROUP BY 1 ORDER BY 1`,
        [range.since, range.until, ...zoneParams]
      );
      let registrations = null;
      if (!municipality) {
        const [users] = await pool.execute(
          `SELECT TO_CHAR(fecha_registro, 'YYYY-MM') AS mes, COUNT(*) AS total
           FROM usuario
           WHERE fecha_registro >= ?::date AND fecha_registro < (?::date + INTERVAL '1 day')
           GROUP BY 1 ORDER BY 1`,
          [range.since, range.until]
        );
        registrations = users;
      }
      const sum = (rows) => rows.reduce((total, row) => total + Number(row.total), 0);
      return response.json({
        desde: range.since,
        hasta: range.until,
        municipio: municipality || null,
        totales: {
          servicios_terminados: sum(finished),
          incidencias: sum(reports),
          registros: registrations ? sum(registrations) : null
        },
        por_mes: {
          servicios_terminados: finished,
          incidencias: reports,
          registros: registrations
        }
      });
    } catch (error) {
      console.error("Error al consultar métricas:", error);
      return response.status(500).json({ message: "No fue posible generar las métricas." });
    }
  });

  // Reportes técnicos enviados por los usuarios (máximo 12 meses).
  app.get("/api/admin/tickets", requireSession, requireRole("administrador"), async (request, response) => {
    const range = readRange(request.query, TICKETS_MAX_DAYS);
    if (range.error) return response.status(400).json({ message: range.error });
    const moduleName = String(request.query.modulo || "").trim();
    try {
      const params = [range.since, range.until];
      let where = "t.fecha_reporte >= ?::date AND t.fecha_reporte < (?::date + INTERVAL '1 day')";
      if (moduleName) {
        where += " AND t.modulo = ?";
        params.push(moduleName);
      }
      const [rows] = await pool.execute(
        `SELECT t.id_ticket AS id, t.modulo, t.descripcion, t.navegador, t.fecha_reporte,
                (t.captura_cifrada IS NOT NULL) AS tiene_captura,
                COALESCE(u.nombre_completo, 'Sin sesión') AS usuario
         FROM ticket_error t
         LEFT JOIN usuario u ON u.id_usuario = t.id_usuario
         WHERE ${where}
         ORDER BY t.fecha_reporte DESC
         LIMIT 300`,
        params
      );
      return response.json({ tickets: rows });
    } catch (error) {
      console.error("Error al listar tickets:", error);
      return response.status(500).json({ message: "No fue posible consultar los reportes técnicos." });
    }
  });

  // Cambio obligatorio de la contraseña temporal del administrador.
  app.post("/api/cuenta/cambiar-contrasena", requireSession, createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 10, message: "Demasiados intentos. Espera unos minutos."
  }), async (request, response) => {
    const current = request.body.actual;
    const next = request.body.nueva;
    const userId = request.session.user.id;
    if (typeof current !== "string" || typeof next !== "string") {
      return response.status(400).json({ message: "Completa los campos de contraseña." });
    }
    if (next.length < 8 || Buffer.byteLength(next, "utf8") > 72 || !/\p{L}/u.test(next) || !/\d/.test(next)) {
      return response.status(400).json({ message: "La contraseña debe tener de 8 a 72 caracteres, con al menos una letra y un número." });
    }
    try {
      const [rows] = await pool.execute("SELECT password_hash FROM usuario WHERE id_usuario = ?", [userId]);
      if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) {
        return response.status(403).json({ message: "La contraseña actual no es correcta." });
      }
      if (await bcrypt.compare(next, rows[0].password_hash)) {
        return response.status(400).json({ message: "La nueva contraseña debe ser distinta a la actual." });
      }
      await pool.execute(
        "INSERT INTO historial_contrasena (id_usuario, password_hash) VALUES (?, ?)",
        [userId, rows[0].password_hash]
      );
      await pool.execute(
        "UPDATE usuario SET password_hash = ?, debe_cambiar_contrasena = FALSE WHERE id_usuario = ?",
        [await bcrypt.hash(next, 12), userId]
      );
      request.session.user.mustChange = false;
      return response.json({ message: "Contraseña actualizada.", redirect: "/admin/usuarios.html" });
    } catch (error) {
      console.error("Error al cambiar contraseña:", error);
      return response.status(500).json({ message: "No fue posible cambiar la contraseña." });
    }
  });
}

module.exports = { registerGestionRoutes, verifyOwnCode, temporaryPassword };
