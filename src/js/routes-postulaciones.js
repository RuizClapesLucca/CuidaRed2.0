// Postulaciones: el prestador se postula con una tarifa y un mensaje; el solicitante
// acepta una (el servicio queda confirmado) o la rechaza. Al terminar, ambas partes
// deben confirmar el cierre, o el sistema lo cierra solo a las 24 horas.
const { requireSession, requireRole } = require("./middleware");
const { finalizeService, expirePostulations } = require("./services-lifecycle");

const POSTULATION = { ENVIADA: 1, ACEPTADA: 2, RECHAZADA: 3, RETIRADA: 4 };
const PETITION = { EN_ESPERA: 1, POR_EMPEZAR: 2 };

// Las categorías de transporte exigen que el prestador tenga coche registrado.
function requiresVehicle(categoryName) {
  const name = String(categoryName || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return name.includes("transporte") || name.includes("traslado");
}

function registerPostulationRoutes(app, pool) {
  // Prestador: envía una postulación con tarifa y mensaje.
  app.post("/api/solicitudes/:id/postular", requireRole("prestador"), async (request, response) => {
    const requestId = Number(request.params.id);
    const fee = Number(request.body.tarifa);
    const message = String(request.body.mensaje || "").trim();
    if (
      !Number.isInteger(requestId) || requestId <= 0 ||
      !Number.isFinite(fee) || fee < 50 || fee > 5000 ||
      message.length > 250
    ) {
      return response.status(400).json({
        message: "Revisa la tarifa (entre 50 y 5,000 MXN) y el mensaje (máximo 250 caracteres)."
      });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [petitions] = await connection.execute(
        `SELECT p.id_peticion, c.nombre AS categoria
         FROM peticion p
         JOIN cat_categoria c ON c.id_categoria = p.id_categoria
         WHERE p.id_peticion = ? AND p.id_estado_peticion = ?
           AND (p.fecha_programada + p.hora_programada) > (NOW() AT TIME ZONE 'UTC')
         FOR UPDATE OF p`,
        [requestId, PETITION.EN_ESPERA]
      );
      if (petitions.length === 0) {
        await connection.rollback();
        return response.status(409).json({ message: "La solicitud ya no está disponible." });
      }
      const [profiles] = await connection.execute(
        "SELECT id_perfil, cuenta_con_coche FROM perfil_prestador WHERE id_usuario = ? AND activo = TRUE",
        [request.session.user.id]
      );
      if (profiles.length === 0) {
        await connection.rollback();
        return response.status(400).json({ message: "Tu perfil de prestador no está activo." });
      }
      if (requiresVehicle(petitions[0].categoria) && !profiles[0].cuenta_con_coche) {
        await connection.rollback();
        return response.status(403).json({ message: "Necesitas registrar un coche para postularte a esta solicitud." });
      }
      const [previous] = await connection.execute(
        "SELECT id_estado_postulacion FROM postulacion WHERE id_peticion = ? AND id_perfil = ?",
        [requestId, profiles[0].id_perfil]
      );
      if (previous.length > 0) {
        await connection.rollback();
        const active = Number(previous[0].id_estado_postulacion) === POSTULATION.ENVIADA;
        return response.status(409).json({
          message: active
            ? "Ya enviaste una postulación para esta solicitud."
            : "Ya no puedes volver a postularte a esta solicitud."
        });
      }
      await connection.execute(
        `INSERT INTO postulacion (id_peticion, id_perfil, mensaje, tarifa_propuesta, id_estado_postulacion, fecha_postulacion)
         VALUES (?, ?, ?, ?, ?, (NOW() AT TIME ZONE 'UTC'))`,
        [requestId, profiles[0].id_perfil, message || null, fee, POSTULATION.ENVIADA]
      );
      await connection.commit();
      return response.status(201).json({ message: "Postulación enviada. El solicitante te responderá." });
    } catch (error) {
      await connection.rollback();
      if (error.code === "23505") {
        return response.status(409).json({ message: "Ya enviaste una postulación para esta solicitud." });
      }
      console.error("Error al postularse:", error);
      return response.status(500).json({ message: "No fue posible enviar la postulación." });
    } finally {
      connection.release();
    }
  });

  // Prestador: retira una postulación que sigue Enviada.
  app.post("/api/postulaciones/:id/retirar", requireRole("prestador"), async (request, response) => {
    const postulationId = Number(request.params.id);
    if (!Number.isInteger(postulationId) || postulationId <= 0) {
      return response.status(400).json({ message: "La postulación no es válida." });
    }
    try {
      const [result] = await pool.execute(
        `UPDATE postulacion
         SET id_estado_postulacion = ?, fecha_decision = (NOW() AT TIME ZONE 'UTC')
         FROM perfil_prestador pp
         WHERE postulacion.id_postulacion = ?
           AND pp.id_perfil = postulacion.id_perfil
           AND pp.id_usuario = ?
           AND postulacion.id_estado_postulacion = ?`,
        [POSTULATION.RETIRADA, postulationId, request.session.user.id, POSTULATION.ENVIADA]
      );
      if (result.affectedRows === 0) {
        return response.status(409).json({ message: "La postulación ya no se puede retirar." });
      }
      return response.json({ message: "Postulación retirada." });
    } catch (error) {
      console.error("Error al retirar postulación:", error);
      return response.status(500).json({ message: "No fue posible retirar la postulación." });
    }
  });

  // Solicitante: ve las postulaciones de una solicitud propia.
  app.get("/api/solicitudes/:id/postulaciones", requireRole("solicitante"), async (request, response) => {
    const requestId = Number(request.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return response.status(400).json({ message: "La solicitud no es válida." });
    }
    try {
      await expirePostulations(pool);
      const [owner] = await pool.execute(
        "SELECT 1 FROM peticion WHERE id_peticion = ? AND id_buscador = ?",
        [requestId, request.session.user.id]
      );
      if (owner.length === 0) {
        return response.status(404).json({ message: "No se encontró la solicitud." });
      }
      const [rows] = await pool.execute(
        `SELECT po.id_postulacion AS id, po.mensaje, po.tarifa_propuesta,
                po.id_estado_postulacion AS estado_id, e.nombre AS estado,
                u.nombre_completo AS prestador, r.promedio,
                COALESCE(r.total_evaluaciones, 0) AS total_evaluaciones
         FROM postulacion po
         JOIN cat_estado_postulacion e ON e.id_estado_postulacion = po.id_estado_postulacion
         JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         JOIN usuario u ON u.id_usuario = pp.id_usuario
         LEFT JOIN reputacion r ON r.id_usuario = u.id_usuario
         WHERE po.id_peticion = ?
         ORDER BY po.fecha_postulacion DESC`,
        [requestId]
      );
      const postulations = rows.map((item) => ({
        id: item.id,
        prestador: item.prestador,
        mensaje: item.mensaje || "",
        tarifa_propuesta: item.tarifa_propuesta,
        estado_id: Number(item.estado_id),
        estado: item.estado,
        calificacion: Number(item.total_evaluaciones) > 0
          ? `Calificación ${item.promedio} (${item.total_evaluaciones} evaluaciones)`
          : "Sin calificaciones"
      }));
      return response.json({ postulations });
    } catch (error) {
      console.error("Error al consultar postulaciones:", error);
      return response.status(500).json({ message: "No fue posible consultar las postulaciones." });
    }
  });

  // Solicitante: acepta una postulación. Confirma el servicio, cierra las demás
  // postulaciones de la solicitud y pasa la solicitud a Por Empezar.
  app.post("/api/postulaciones/:id/aceptar", requireRole("solicitante"), async (request, response) => {
    const postulationId = Number(request.params.id);
    if (!Number.isInteger(postulationId) || postulationId <= 0) {
      return response.status(400).json({ message: "La postulación no es válida." });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT po.id_postulacion, po.id_peticion, po.id_estado_postulacion, po.tarifa_propuesta,
                p.id_buscador, p.id_estado_peticion,
                ((p.fecha_programada + p.hora_programada) > (NOW() AT TIME ZONE 'UTC')) AS vigente,
                c.nombre AS categoria, pp.activo, pp.cuenta_con_coche
         FROM postulacion po
         JOIN peticion p ON p.id_peticion = po.id_peticion
         JOIN cat_categoria c ON c.id_categoria = p.id_categoria
         JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         WHERE po.id_postulacion = ?
         FOR UPDATE OF p, po`,
        [postulationId]
      );
      const item = rows[0];
      if (!item || Number(item.id_buscador) !== request.session.user.id) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró la postulación." });
      }
      if (Number(item.id_estado_peticion) !== PETITION.EN_ESPERA) {
        await connection.rollback();
        return response.status(409).json({ message: "Esta solicitud ya fue asignada o cerrada." });
      }
      if (Number(item.id_estado_postulacion) !== POSTULATION.ENVIADA) {
        await connection.rollback();
        return response.status(409).json({ message: "La postulación ya no está disponible." });
      }
      if (!item.vigente) {
        await connection.rollback();
        return response.status(409).json({ message: "La fecha de la solicitud ya pasó." });
      }
      if (!item.activo) {
        await connection.rollback();
        return response.status(409).json({ message: "El prestador ya no está disponible." });
      }
      if (requiresVehicle(item.categoria) && !item.cuenta_con_coche) {
        await connection.rollback();
        return response.status(403).json({ message: "El prestador necesita un coche para este servicio." });
      }
      await connection.execute(
        "UPDATE postulacion SET id_estado_postulacion = ?, fecha_decision = (NOW() AT TIME ZONE 'UTC') WHERE id_postulacion = ?",
        [POSTULATION.ACEPTADA, postulationId]
      );
      await connection.execute(
        `UPDATE postulacion
         SET id_estado_postulacion = ?, fecha_decision = (NOW() AT TIME ZONE 'UTC'),
             motivo_rechazo = 'La solicitud fue asignada a otra persona.'
         WHERE id_peticion = ? AND id_postulacion <> ? AND id_estado_postulacion = ?`,
        [POSTULATION.RECHAZADA, item.id_peticion, postulationId, POSTULATION.ENVIADA]
      );
      await connection.execute(
        "UPDATE peticion SET id_estado_peticion = ?, monto_final = ? WHERE id_peticion = ?",
        [PETITION.POR_EMPEZAR, item.tarifa_propuesta, item.id_peticion]
      );
      await connection.execute(
        "INSERT INTO servicio (id_peticion, id_postulacion) VALUES (?, ?)",
        [item.id_peticion, postulationId]
      );
      await connection.commit();
      return response.json({ message: "Postulación aceptada. El servicio quedó confirmado." });
    } catch (error) {
      await connection.rollback();
      console.error("Error al aceptar postulación:", error);
      return response.status(500).json({ message: "No fue posible aceptar la postulación." });
    } finally {
      connection.release();
    }
  });

  // Solicitante: rechaza una postulación pendiente.
  app.post("/api/postulaciones/:id/rechazar", requireRole("solicitante"), async (request, response) => {
    const postulationId = Number(request.params.id);
    if (!Number.isInteger(postulationId) || postulationId <= 0) {
      return response.status(400).json({ message: "La postulación no es válida." });
    }
    const reason = String(request.body.motivo || "").trim().slice(0, 200) || "No fue seleccionada por el solicitante.";
    try {
      const [result] = await pool.execute(
        `UPDATE postulacion
         SET id_estado_postulacion = ?, motivo_rechazo = ?, fecha_decision = (NOW() AT TIME ZONE 'UTC')
         FROM peticion p
         WHERE postulacion.id_postulacion = ?
           AND p.id_peticion = postulacion.id_peticion
           AND p.id_buscador = ?
           AND postulacion.id_estado_postulacion = ?`,
        [POSTULATION.RECHAZADA, reason, postulationId, request.session.user.id, POSTULATION.ENVIADA]
      );
      if (result.affectedRows === 0) {
        return response.status(409).json({ message: "La postulación ya no se puede rechazar." });
      }
      return response.json({ message: "Postulación rechazada." });
    } catch (error) {
      console.error("Error al rechazar postulación:", error);
      return response.status(500).json({ message: "No fue posible rechazar la postulación." });
    }
  });

  // Prestador o solicitante: pide terminar el servicio. El servicio termina cuando
  // ambas partes lo piden, o automáticamente 24 horas después de la primera solicitud.
  app.post("/api/servicios/:id/finalizar", requireSession, async (request, response) => {
    const serviceId = Number(request.params.id);
    const role = request.session.user.role;
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !["prestador", "solicitante"].includes(role)) {
      return response.status(400).json({ message: "El servicio no es válido." });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT s.id_servicio, s.confirmado_prestador, s.cierre_prestador, s.cierre_buscador,
                p.id_estado_peticion, p.id_buscador, pp.id_usuario AS prestador
         FROM servicio s
         JOIN peticion p ON p.id_peticion = s.id_peticion
         JOIN postulacion po ON po.id_postulacion = s.id_postulacion
         JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         WHERE s.id_servicio = ?
         FOR UPDATE OF s, p`,
        [serviceId]
      );
      const service = rows[0];
      const userId = request.session.user.id;
      const isBuyer = Boolean(service) && role === "solicitante" && Number(service.id_buscador) === userId;
      const isProvider = Boolean(service) && role === "prestador" && Number(service.prestador) === userId;
      if (!service || (!isBuyer && !isProvider)) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró el servicio." });
      }
      if (Number(service.id_estado_peticion) !== PETITION.POR_EMPEZAR) {
        await connection.rollback();
        return response.status(409).json({ message: "Este servicio ya no está en curso." });
      }
      if (!service.confirmado_prestador) {
        await connection.rollback();
        return response.status(409).json({ message: "El servicio debe iniciarse antes de terminarlo." });
      }
      const otherPartyAsked = isBuyer ? service.cierre_prestador : service.cierre_buscador;
      if (isBuyer) {
        await connection.execute(
          `UPDATE servicio SET cierre_buscador = TRUE,
             fecha_solicitud_cierre = COALESCE(fecha_solicitud_cierre, (NOW() AT TIME ZONE 'UTC'))
           WHERE id_servicio = ?`,
          [serviceId]
        );
      } else {
        await connection.execute(
          `UPDATE servicio SET cierre_prestador = TRUE,
             fecha_solicitud_cierre = COALESCE(fecha_solicitud_cierre, (NOW() AT TIME ZONE 'UTC'))
           WHERE id_servicio = ?`,
          [serviceId]
        );
      }
      let message = "Enviamos tu solicitud de cierre. El servicio se terminará cuando la otra parte confirme o en 24 horas.";
      if (otherPartyAsked) {
        await finalizeService(connection, serviceId);
        message = "Servicio terminado. Ya pueden calificarse.";
      }
      await connection.commit();
      return response.json({ message });
    } catch (error) {
      await connection.rollback();
      console.error("Error al terminar servicio:", error);
      return response.status(500).json({ message: "No fue posible terminar el servicio." });
    } finally {
      connection.release();
    }
  });
}

module.exports = { registerPostulationRoutes };
