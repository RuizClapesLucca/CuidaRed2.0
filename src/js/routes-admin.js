// Rutas del administrador: consultar cuentas de usuarios normales y desactivarlas.
// La desactivación es lógica: la cuenta pasa a Inhabilitada y queda registrada en
// medida_cuenta y bitacora. No se borra ninguna fila.
const { requireSession, requireRole } = require("./middleware");
const { cancelOpenRequests, logEvent, STATE_DISABLED } = require("./routes-account");

const USERS_PER_PAGE = 20;
const PERMANENT_REMOVAL_MEASURE = 3;

// Escapa los comodines de LIKE para que la búsqueda trate % y _ como texto.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

// Registra los endpoints exclusivos del administrador.
function registerAdminRoutes(app, pool) {
  // Lista solo prestadores y solicitantes; las cuentas de administrador nunca aparecen.
  app.get("/api/admin/usuarios", requireSession, requireRole("administrador"), async (request, response) => {
    const search = String(request.query.q || "").trim();
    const page = Number(request.query.pagina || 1);
    if (search.length > 80 || !Number.isInteger(page) || page < 1 || page > 10000) {
      return response.status(400).json({ message: "La búsqueda no es válida." });
    }
    try {
      const pattern = `%${escapeLike(search)}%`;
      const [rows] = await pool.execute(
        `SELECT u.id_usuario AS id, u.nombre_completo, u.correo, u.id_estado_cuenta,
                e.nombre AS estado,
                CASE WHEN EXISTS (
                  SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = 2
                ) THEN 'Prestador' ELSE 'Solicitante' END AS tipo
         FROM usuario u
         JOIN cat_estado_cuenta e ON e.id_estado_cuenta = u.id_estado_cuenta
         WHERE NOT EXISTS (
                 SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol IN (3, 4))
           AND (u.nombre_completo ILIKE ? OR u.correo ILIKE ?)
         ORDER BY u.fecha_registro DESC, u.id_usuario DESC
         LIMIT ${USERS_PER_PAGE + 1} OFFSET ?`,
        [pattern, pattern, (page - 1) * USERS_PER_PAGE]
      );
      return response.json({
        users: rows.slice(0, USERS_PER_PAGE),
        hasMore: rows.length > USERS_PER_PAGE
      });
    } catch (error) {
      console.error("Error al listar usuarios:", error);
      return response.status(500).json({ message: "No fue posible consultar los usuarios." });
    }
  });

  // Desactiva la cuenta de un usuario normal. Pide un motivo para dejar constancia.
  app.post("/api/admin/usuarios/:id/desactivar", requireSession, requireRole("administrador"), async (request, response) => {
    const targetId = Number(request.params.id);
    const reason = String(request.body.motivo || "").trim().replace(/\s+/g, " ");
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return response.status(400).json({ message: "El usuario no es válido." });
    }
    if (reason.length < 10 || reason.length > 250) {
      return response.status(400).json({ message: "El motivo debe tener entre 10 y 250 caracteres." });
    }
    const adminId = request.session.user.id;
    if (targetId === adminId) {
      return response.status(400).json({ message: "No puedes desactivar tu propia cuenta desde aquí." });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [targets] = await connection.execute(
        "SELECT id_estado_cuenta FROM usuario WHERE id_usuario = ? FOR UPDATE",
        [targetId]
      );
      if (targets.length === 0) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró el usuario." });
      }
      const [adminRoles] = await connection.execute(
        "SELECT 1 FROM usuario_rol WHERE id_usuario = ? AND id_rol IN (3, 4)",
        [targetId]
      );
      if (adminRoles.length > 0) {
        await connection.rollback();
        return response.status(403).json({ message: "No se pueden desactivar cuentas de administrador." });
      }
      const previousState = Number(targets[0].id_estado_cuenta);
      if (previousState === STATE_DISABLED) {
        await connection.rollback();
        return response.status(409).json({ message: "La cuenta ya está desactivada." });
      }

      await cancelOpenRequests(connection, targetId, true);
      await connection.execute(
        "UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ?",
        [STATE_DISABLED, targetId]
      );
      await connection.execute(
        `UPDATE perfil_prestador
         SET activo = FALSE, fecha_actualizacion = (NOW() AT TIME ZONE 'UTC')
         WHERE id_usuario = ?`,
        [targetId]
      );
      await connection.execute(
        `INSERT INTO medida_cuenta (id_usuario, id_tipo_medida, motivo, id_administrador)
         VALUES (?, ?, ?, ?)`,
        [targetId, PERMANENT_REMOVAL_MEASURE, reason, adminId]
      );
      await logEvent(connection, adminId, "CUENTA_DESACTIVADA_ADMIN", targetId, {
        estado_previo: previousState,
        motivo: reason
      });
      await connection.commit();
      return response.json({ message: "La cuenta fue desactivada." });
    } catch (error) {
      await connection.rollback();
      console.error("Error al desactivar cuenta:", error);
      return response.status(500).json({ message: "No fue posible desactivar la cuenta." });
    } finally {
      connection.release();
    }
  });
}

module.exports = { registerAdminRoutes };
