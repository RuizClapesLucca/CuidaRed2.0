// Rutas de la cuenta propia: motivos de baja y borrado lógico con periodo de gracia.
// Nada se borra físicamente: la cuenta cambia de estado y puede recuperarse si la
// persona vuelve a iniciar sesión antes de que termine el plazo.
const bcrypt = require("bcrypt");
const { requireSession, createRateLimiter } = require("./middleware");

// Estados de cat_estado_cuenta que usa este módulo.
const STATE_PENDING = 1;
const STATE_ACTIVE = 2;
const STATE_DELETED = 5;
const STATE_DISABLED = 6;

// Días que una cuenta borrada puede recuperarse iniciando sesión.
const DELETE_GRACE_DAYS = 30;

// Registra una acción importante en la bitácora para poder auditarla después.
async function logEvent(connection, userId, action, entityId, detail) {
  await connection.execute(
    `INSERT INTO bitacora (id_usuario, accion, entidad, id_entidad, detalle)
     VALUES (?, ?, 'usuario', ?, ?::jsonb)`,
    [userId, action, entityId, JSON.stringify(detail || {})]
  );
}

// Cancela de forma lógica las solicitudes abiertas de una cuenta para que dejen de
// verse en el listado de prestadores. Con includeAccepted también cancela las ya
// aceptadas, tanto las que publicó la persona como las que tenía a su cargo.
async function cancelOpenRequests(connection, userId, includeAccepted) {
  const openStates = includeAccepted ? "1, 2" : "1";
  await connection.execute(
    `UPDATE peticion
     SET id_estado_peticion = 4,
         fecha_cancelacion = (NOW() AT TIME ZONE 'UTC'),
         fecha_actualizacion = (NOW() AT TIME ZONE 'UTC')
     WHERE id_estado_peticion IN (${openStates})
       AND (id_buscador = ?
         OR id_peticion IN (
           SELECT s.id_peticion
           FROM servicio s
           JOIN postulacion po ON po.id_postulacion = s.id_postulacion
           JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
           WHERE pp.id_usuario = ?))`,
    [userId, userId]
  );
}

// Devuelve la cuenta a su estado anterior al borrado. El estado previo se guardó
// en la bitácora; si no se encuentra, la cuenta vuelve a quedar activa.
async function reactivateAccount(pool, userId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [logs] = await connection.execute(
      `SELECT detalle->>'estado_previo' AS estado_previo
       FROM bitacora
       WHERE id_usuario = ? AND accion = 'CUENTA_BORRADA'
       ORDER BY id_bitacora DESC
       LIMIT 1`,
      [userId]
    );
    const previousState = Number(logs[0] && logs[0].estado_previo);
    const restoredState = [STATE_PENDING, STATE_ACTIVE].includes(previousState) ? previousState : STATE_ACTIVE;
    await connection.execute(
      `UPDATE usuario
       SET id_estado_cuenta = ?, fecha_eliminacion = NULL, motivo_baja_id = NULL
       WHERE id_usuario = ? AND id_estado_cuenta = ?`,
      [restoredState, userId, STATE_DELETED]
    );
    await connection.execute(
      `UPDATE perfil_prestador
       SET activo = TRUE, fecha_actualizacion = (NOW() AT TIME ZONE 'UTC')
       WHERE id_usuario = ?`,
      [userId]
    );
    await logEvent(connection, userId, "CUENTA_REACTIVADA", userId, { estado_restaurado: restoredState });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// Pasa a Inhabilitada una cuenta cuyo plazo de recuperación ya terminó.
async function expireDeletedAccount(pool, userId) {
  await pool.execute(
    "UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ? AND id_estado_cuenta = ?",
    [STATE_DISABLED, userId, STATE_DELETED]
  );
}

// Registra los endpoints para que una persona borre su propia cuenta.
function registerAccountRoutes(app, pool) {
  // Borrar la cuenta pide la contraseña, así que se limitan los intentos por IP.
  const deleteLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Demasiados intentos. Espera unos minutos para continuar."
  });

  // Entrega el catálogo de motivos para el formulario de borrado.
  app.get("/api/motivos-baja", requireSession, async (request, response) => {
    try {
      const [reasons] = await pool.execute(
        "SELECT id_motivo AS id, nombre FROM cat_motivo_baja ORDER BY id_motivo"
      );
      return response.json({ reasons });
    } catch (error) {
      console.error("Error al consultar motivos de baja:", error);
      return response.status(500).json({ message: "No fue posible cargar los motivos." });
    }
  });

  // Desactiva la cuenta de la sesión actual. Aplica a solicitantes, prestadores y
  // administradores; el administrador principal no puede borrarse para no dejar
  // el sistema sin quien lo administre.
  app.post("/api/cuenta/borrar", requireSession, deleteLimiter, async (request, response) => {
    const password = request.body.password;
    const reasonId = Number(request.body.id_motivo);
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128 ||
      !Number.isInteger(reasonId) ||
      reasonId <= 0
    ) {
      return response.status(400).json({ message: "Escribe tu contraseña y selecciona un motivo válido." });
    }

    const userId = request.session.user.id;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        "SELECT password_hash, id_estado_cuenta FROM usuario WHERE id_usuario = ? FOR UPDATE",
        [userId]
      );
      const user = users[0];
      if (!user || ![STATE_PENDING, STATE_ACTIVE].includes(Number(user.id_estado_cuenta))) {
        await connection.rollback();
        return response.status(409).json({ message: "Tu cuenta no está activa." });
      }
      if (!(await bcrypt.compare(password, user.password_hash))) {
        await connection.rollback();
        return response.status(403).json({ message: "La contraseña no es correcta." });
      }

      const [reasons] = await connection.execute(
        "SELECT id_motivo FROM cat_motivo_baja WHERE id_motivo = ?",
        [reasonId]
      );
      if (reasons.length === 0) {
        await connection.rollback();
        return response.status(400).json({ message: "Selecciona un motivo válido." });
      }

      const [principalAdmin] = await connection.execute(
        "SELECT 1 FROM usuario_rol WHERE id_usuario = ? AND id_rol = 4",
        [userId]
      );
      if (principalAdmin.length > 0) {
        await connection.rollback();
        return response.status(409).json({ message: "La cuenta de administrador principal no puede borrarse." });
      }

      // Un servicio aceptado involucra a otra persona; primero debe terminarse o
      // cancelarse desde la solicitud para no dejarla sin respuesta.
      const [acceptedServices] = await connection.execute(
        `SELECT 1
         FROM peticion p
         LEFT JOIN servicio s ON s.id_peticion = p.id_peticion
         LEFT JOIN postulacion po ON po.id_postulacion = s.id_postulacion
         LEFT JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         WHERE p.id_estado_peticion = 2 AND (p.id_buscador = ? OR pp.id_usuario = ?)
         LIMIT 1`,
        [userId, userId]
      );
      if (acceptedServices.length > 0) {
        await connection.rollback();
        return response.status(409).json({
          message: "Tienes servicios aceptados pendientes. Termínalos o cancélalos antes de borrar tu cuenta."
        });
      }

      await cancelOpenRequests(connection, userId, false);
      await connection.execute(
        `UPDATE usuario
         SET id_estado_cuenta = ?, fecha_eliminacion = (NOW() AT TIME ZONE 'UTC'), motivo_baja_id = ?
         WHERE id_usuario = ?`,
        [STATE_DELETED, reasonId, userId]
      );
      await connection.execute(
        `UPDATE perfil_prestador
         SET activo = FALSE, fecha_actualizacion = (NOW() AT TIME ZONE 'UTC')
         WHERE id_usuario = ?`,
        [userId]
      );
      await logEvent(connection, userId, "CUENTA_BORRADA", userId, {
        estado_previo: Number(user.id_estado_cuenta),
        id_motivo: reasonId
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error("Error al borrar cuenta:", error);
      return response.status(500).json({ message: "No fue posible borrar la cuenta." });
    } finally {
      connection.release();
    }

    // La sesión se cierra después de confirmar el cambio en la base de datos.
    return request.session.destroy(() => {
      response.json({
        message: `Tu cuenta fue desactivada. Tienes ${DELETE_GRACE_DAYS} días para recuperarla iniciando sesión.`,
        redirect: "/Modulo1.html"
      });
    });
  });
}

module.exports = {
  registerAccountRoutes,
  reactivateAccount,
  expireDeletedAccount,
  cancelOpenRequests,
  logEvent,
  DELETE_GRACE_DAYS,
  STATE_DELETED,
  STATE_DISABLED
};
