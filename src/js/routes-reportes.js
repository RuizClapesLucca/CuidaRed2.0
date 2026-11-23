// Reportes con evidencias (solicitante o prestador), reportes técnicos del sistema
// y panel de incidencias del administrador: revisar, desestimar, advertir o suspender.
const multer = require("multer");
const { requireSession, requireRole } = require("./middleware");
const { encryptBuffer, decryptBuffer } = require("./config");
const { logEvent } = require("./routes-account");
const { sendMail } = require("./email");
const { applySuspension } = require("./sanciones");

const MAX_EVIDENCE_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const REPORT_WINDOW_DAYS = 7;
const REPORT_QUERY_MAX_DAYS = 365;
const TICKET_MODULES = ["AUTENTICACION", "REGISTRO", "PETICIONES", "PRESTADORES", "SERVICIOS", "CALIFICACIONES", "REPORTES", "OTRO"];
const REPORT = { PENDIENTE: 1, EN_REVISION: 2, RESUELTO: 3, DESESTIMADO: 4 };
const ACTIONS = ["desestimar", "advertir", "suspender", "eliminar"];

const captureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

const acceptCapture = (request, response, next) => {
  captureUpload.single("captura")(request, response, (error) => {
    if (!error) return next();
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "La captura debe pesar menos de 5 MB."
      : "Adjunta la captura en formato JPG o PNG.";
    return response.status(400).json({ message });
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_EVIDENCE_FILES }
});

// Detecta el tipo real del archivo por sus primeros bytes, no por su nombre ni su encabezado.
function detectMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  return null;
}

function isValidDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime());
}

function shiftDate(text, days) {
  const date = new Date(`${text}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function registerReportRoutes(app, pool) {
  const acceptEvidence = (request, response, next) => {
    upload.array("evidencias", MAX_EVIDENCE_FILES)(request, response, (error) => {
      if (!error) return next();
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "Cada archivo debe pesar menos de 10 MB."
        : "Adjunta como máximo 3 archivos JPG, PNG o PDF.";
      return response.status(400).json({ message });
    });
  };

  app.get("/api/motivos-reporte", requireSession, async (request, response) => {
    const [reasons] = await pool.execute("SELECT id_motivo AS id, nombre FROM cat_motivo_reporte ORDER BY id_motivo");
    return response.json({ reasons });
  });

  // Levanta un reporte sobre un servicio, con hasta 3 evidencias cifradas en la base.
  app.post("/api/servicios/:id/reportes", requireSession, acceptEvidence, async (request, response) => {
    const serviceId = Number(request.params.id);
    const role = request.session.user.role;
    const userId = request.session.user.id;
    const reasonId = Number(request.body.id_motivo);
    const description = String(request.body.descripcion || "").trim();
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !["solicitante", "prestador"].includes(role)) {
      return response.status(400).json({ message: "El servicio no es válido." });
    }
    if (!Number.isInteger(reasonId) || reasonId <= 0) {
      return response.status(400).json({ message: "Selecciona un motivo para el reporte." });
    }
    if (description.length < 20 || description.length > 1000) {
      return response.status(400).json({ message: "La descripción debe tener entre 20 y 1000 caracteres." });
    }
    const files = request.files || [];
    const evidences = [];
    for (const file of files) {
      const mime = detectMime(file.buffer);
      if (!mime) {
        return response.status(400).json({ message: "Formato no admitido. Usa JPG, PNG o PDF." });
      }
      evidences.push({ mime, size: file.size, name: String(file.originalname || "evidencia").slice(0, 120), buffer: file.buffer });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT p.id_peticion, p.id_estado_peticion, p.id_buscador,
                pp.id_usuario AS prestador,
                (p.fecha_terminado >= ((NOW() AT TIME ZONE 'UTC') - make_interval(days => ?::int))) AS dentro_de_plazo
         FROM servicio s
         JOIN peticion p ON p.id_peticion = s.id_peticion
         JOIN postulacion po ON po.id_postulacion = s.id_postulacion
         JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         WHERE s.id_servicio = ?`,
        [REPORT_WINDOW_DAYS, serviceId]
      );
      const service = rows[0];
      const isBuyer = Boolean(service) && role === "solicitante" && Number(service.id_buscador) === userId;
      const isProvider = Boolean(service) && role === "prestador" && Number(service.prestador) === userId;
      if (!isBuyer && !isProvider) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró el servicio." });
      }
      const state = Number(service.id_estado_peticion);
      if (state === 3 && !service.dentro_de_plazo) {
        await connection.rollback();
        return response.status(409).json({ message: `El tiempo límite para reportar este servicio (${REPORT_WINDOW_DAYS} días) ha expirado.` });
      }
      if (state !== 2 && state !== 3) {
        await connection.rollback();
        return response.status(409).json({ message: "Este servicio no admite reportes en su estado actual." });
      }
      const [reasons] = await connection.execute("SELECT id_motivo FROM cat_motivo_reporte WHERE id_motivo = ?", [reasonId]);
      if (reasons.length === 0) {
        await connection.rollback();
        return response.status(400).json({ message: "Selecciona un motivo válido." });
      }
      const [open] = await connection.execute(
        "SELECT 1 FROM reporte WHERE id_servicio = ? AND id_reportante = ? AND id_estado_reporte IN (1, 2)",
        [serviceId, userId]
      );
      if (open.length > 0) {
        await connection.rollback();
        return response.status(409).json({ message: "Ya tienes un reporte abierto para este servicio." });
      }
      const reportedId = isBuyer ? service.prestador : service.id_buscador;
      const [inserted] = await connection.execute(
        `INSERT INTO reporte (id_servicio, id_reportante, id_reportado, id_motivo, descripcion)
         VALUES (?, ?, ?, ?, ?)`,
        [serviceId, userId, reportedId, reasonId, description]
      );
      const reportId = inserted.insertId;
      for (const evidence of evidences) {
        await connection.execute(
          `INSERT INTO evidencia (id_reporte, tipo_mime, tamano_bytes, ruta_cifrada, contenido_cifrado, nombre_original)
           VALUES (?, ?, ?, 'almacenada-en-bd', ?, ?)`,
          [reportId, evidence.mime, evidence.size, encryptBuffer(evidence.buffer), evidence.name]
        );
      }
      await connection.execute("UPDATE peticion SET reportada = TRUE WHERE id_peticion = ?", [service.id_peticion]);
      await connection.commit();
      return response.status(201).json({
        id: reportId,
        message: `Reporte registrado exitosamente con folio #${reportId}.`
      });
    } catch (error) {
      await connection.rollback();
      console.error("Error al levantar reporte:", error);
      return response.status(500).json({ message: "No fue posible registrar el reporte." });
    } finally {
      connection.release();
    }
  });

  // Reporte técnico del sistema (módulo, descripción y navegador).
  app.post("/api/tickets", requireSession, acceptCapture, async (request, response) => {
    const moduleName = String(request.body.modulo || "");
    const description = String(request.body.descripcion || "").trim();
    if (!TICKET_MODULES.includes(moduleName)) {
      return response.status(400).json({ message: "Selecciona el módulo donde ocurrió el error." });
    }
    if (description.length < 10 || description.length > 500) {
      return response.status(400).json({ message: "La descripción debe tener entre 10 y 500 caracteres." });
    }
    let capture = null;
    if (request.file) {
      const mime = detectMime(request.file.buffer);
      if (mime !== "image/jpeg" && mime !== "image/png") {
        return response.status(400).json({ message: "La captura debe ser JPG o PNG." });
      }
      capture = {
        cipher: encryptBuffer(request.file.buffer),
        mime,
        name: String(request.file.originalname || "captura").slice(0, 120)
      };
    }
    try {
      const browser = String(request.get("user-agent") || "").slice(0, 200);
      const [inserted] = await pool.execute(
        `INSERT INTO ticket_error
           (id_usuario, modulo, descripcion, navegador, captura_cifrada, captura_tipo_mime, captura_nombre)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [request.session.user.id, moduleName, description, browser || null,
          capture ? capture.cipher : null, capture ? capture.mime : null, capture ? capture.name : null]
      );
      return response.status(201).json({
        message: `Reporte técnico enviado con éxito. Ticket #TEC-${inserted.insertId}.`
      });
    } catch (error) {
      console.error("Error al registrar ticket:", error);
      return response.status(500).json({ message: "No fue posible enviar el reporte técnico." });
    }
  });

  // Captura de un reporte técnico. Solo administradores, sin caché.
  app.get("/api/admin/tickets/:id/captura", requireSession, requireRole("administrador"), async (request, response) => {
    const ticketId = Number(request.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return response.status(400).json({ message: "El reporte no es válido." });
    }
    const [rows] = await pool.execute(
      "SELECT captura_cifrada, captura_tipo_mime FROM ticket_error WHERE id_ticket = ?",
      [ticketId]
    );
    if (rows.length === 0 || !rows[0].captura_cifrada) {
      return response.status(404).json({ message: "Este reporte no tiene captura." });
    }
    response.setHeader("Content-Type", rows[0].captura_tipo_mime);
    response.setHeader("Content-Disposition", `inline; filename="ticket-${ticketId}"`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(decryptBuffer(rows[0].captura_cifrada));
  });

  // Panel de incidencias: lista por estado y rango de fechas (máximo 12 meses).
  app.get("/api/admin/reportes", requireSession, requireRole("administrador"), async (request, response) => {
    const today = new Date().toISOString().slice(0, 10);
    const until = request.query.hasta ? String(request.query.hasta) : today;
    const since = request.query.desde ? String(request.query.desde) : shiftDate(until, -30);
    if (!isValidDate(until) || !isValidDate(since) || since > until) {
      return response.status(400).json({ message: "El rango de fechas no es válido." });
    }
    const days = (new Date(`${until}T00:00:00Z`) - new Date(`${since}T00:00:00Z`)) / 86400000;
    if (days > REPORT_QUERY_MAX_DAYS) {
      return response.status(400).json({ message: "El rango máximo de consulta es de 12 meses." });
    }
    const stateParam = request.query.estado === undefined || request.query.estado === "" ? "1" : String(request.query.estado);
    const stateFilter = stateParam === "todos" ? null : Number(stateParam);
    if (stateFilter !== null && !Object.values(REPORT).includes(stateFilter)) {
      return response.status(400).json({ message: "El estado no es válido." });
    }
    try {
      const params = [since, until];
      let where = "r.fecha_reporte >= ?::date AND r.fecha_reporte < (?::date + INTERVAL '1 day')";
      if (stateFilter !== null) {
        where += " AND r.id_estado_reporte = ?";
        params.push(stateFilter);
      }
      const [rows] = await pool.execute(
        `SELECT r.id_reporte AS id, r.id_servicio, r.fecha_reporte, r.id_estado_reporte,
                e.nombre AS estado, m.nombre AS motivo,
                rep.nombre_completo AS reportante, rdo.nombre_completo AS reportado,
                (SELECT COUNT(*) FROM evidencia ev WHERE ev.id_reporte = r.id_reporte) AS evidencias
         FROM reporte r
         JOIN cat_estado_reporte e ON e.id_estado_reporte = r.id_estado_reporte
         JOIN cat_motivo_reporte m ON m.id_motivo = r.id_motivo
         JOIN usuario rep ON rep.id_usuario = r.id_reportante
         JOIN usuario rdo ON rdo.id_usuario = r.id_reportado
         WHERE ${where}
         ORDER BY r.fecha_reporte DESC
         LIMIT 200`,
        params
      );
      return response.json({ reports: rows });
    } catch (error) {
      console.error("Error al listar reportes:", error);
      return response.status(500).json({ message: "No fue posible consultar los reportes." });
    }
  });

  app.get("/api/admin/reportes/:id", requireSession, requireRole("administrador"), async (request, response) => {
    const reportId = Number(request.params.id);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return response.status(400).json({ message: "El reporte no es válido." });
    }
    const [rows] = await pool.execute(
      `SELECT r.id_reporte AS id, r.id_servicio, r.descripcion, r.fecha_reporte, r.id_estado_reporte,
              e.nombre AS estado, r.resolucion, r.fecha_resolucion, m.nombre AS motivo,
              rep.nombre_completo AS reportante, rep.correo AS reportante_correo,
              rdo.nombre_completo AS reportado, rdo.correo AS reportado_correo
       FROM reporte r
       JOIN cat_estado_reporte e ON e.id_estado_reporte = r.id_estado_reporte
       JOIN cat_motivo_reporte m ON m.id_motivo = r.id_motivo
       JOIN usuario rep ON rep.id_usuario = r.id_reportante
       JOIN usuario rdo ON rdo.id_usuario = r.id_reportado
       WHERE r.id_reporte = ?`,
      [reportId]
    );
    if (rows.length === 0) {
      return response.status(404).json({ message: "No se encontró el reporte." });
    }
    const [evidences] = await pool.execute(
      "SELECT id_evidencia AS id, nombre_original, tipo_mime, tamano_bytes FROM evidencia WHERE id_reporte = ? ORDER BY id_evidencia",
      [reportId]
    );
    return response.json({ report: rows[0], evidences });
  });

  // Entrega una evidencia descifrada. Solo para administradores, sin caché.
  app.get("/api/admin/evidencias/:id", requireSession, requireRole("administrador"), async (request, response) => {
    const evidenceId = Number(request.params.id);
    if (!Number.isInteger(evidenceId) || evidenceId <= 0) {
      return response.status(400).json({ message: "La evidencia no es válida." });
    }
    const [rows] = await pool.execute(
      "SELECT contenido_cifrado, tipo_mime, nombre_original FROM evidencia WHERE id_evidencia = ?",
      [evidenceId]
    );
    const evidence = rows[0];
    if (!evidence || !evidence.contenido_cifrado) {
      return response.status(404).json({ message: "No se encontró la evidencia." });
    }
    response.setHeader("Content-Type", evidence.tipo_mime);
    response.setHeader("Content-Disposition", `inline; filename="evidencia-${evidenceId}"`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(decryptBuffer(evidence.contenido_cifrado));
  });

  // Resuelve un reporte: desestimar, advertir o suspender (1 a 30 días).
  app.post("/api/admin/reportes/:id/resolver", requireSession, requireRole("administrador"), async (request, response) => {
    const reportId = Number(request.params.id);
    const action = String(request.body.accion || "");
    const reason = String(request.body.justificacion || "").trim();
    const days = Number(request.body.dias || 0);
    const adminId = request.session.user.id;
    if (!Number.isInteger(reportId) || reportId <= 0 || !ACTIONS.includes(action)) {
      return response.status(400).json({ message: "La acción no es válida." });
    }
    if (reason.length < 10 || reason.length > 500) {
      return response.status(400).json({ message: "La justificación debe tener entre 10 y 500 caracteres." });
    }
    if (action === "suspender" && (!Number.isInteger(days) || days < 1 || days > 30)) {
      return response.status(400).json({ message: "La suspensión debe durar entre 1 y 30 días." });
    }
    const connection = await pool.getConnection();
    let parties = [];
    let reportedUser = null;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT id_reporte, id_servicio, id_reportante, id_reportado, id_estado_reporte FROM reporte WHERE id_reporte = ? FOR UPDATE",
        [reportId]
      );
      const report = rows[0];
      if (!report) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró el reporte." });
      }
      if (![REPORT.PENDIENTE, REPORT.EN_REVISION].includes(Number(report.id_estado_reporte))) {
        await connection.rollback();
        return response.status(409).json({ message: "El reporte ya fue resuelto." });
      }
      if (action === "eliminar") {
        // Solo para reportes duplicados o sin fundamento: no puede eliminarse si ya hay una medida.
        const [measures] = await connection.execute("SELECT 1 FROM medida_cuenta WHERE id_reporte = ? LIMIT 1", [reportId]);
        if (measures.length > 0) {
          await connection.rollback();
          return response.status(409).json({ message: "Este reporte ya tiene una medida aplicada. Desestímalo en su lugar." });
        }
        await connection.execute("DELETE FROM evidencia WHERE id_reporte = ?", [reportId]);
        await connection.execute("DELETE FROM reporte WHERE id_reporte = ?", [reportId]);
        await connection.execute(
          `UPDATE peticion p SET reportada = EXISTS (
             SELECT 1 FROM reporte r WHERE r.id_servicio = ? AND r.id_estado_reporte IN (1, 2))
           FROM servicio s WHERE s.id_servicio = ? AND p.id_peticion = s.id_peticion`,
          [report.id_servicio, report.id_servicio]
        );
      } else if (action === "desestimar") {
        await connection.execute(
          `UPDATE reporte SET id_estado_reporte = ?, resolucion = ?, id_administrador = ?,
             fecha_resolucion = (NOW() AT TIME ZONE 'UTC') WHERE id_reporte = ?`,
          [REPORT.DESESTIMADO, reason, adminId, reportId]
        );
        await connection.execute(
          `UPDATE peticion p SET reportada = FALSE FROM servicio s
           WHERE s.id_servicio = ? AND p.id_peticion = s.id_peticion`,
          [report.id_servicio]
        );
      } else {
        await connection.execute(
          `UPDATE reporte SET id_estado_reporte = ?, resolucion = ?, id_administrador = ?,
             fecha_resolucion = (NOW() AT TIME ZONE 'UTC') WHERE id_reporte = ?`,
          [REPORT.RESUELTO, reason, adminId, reportId]
        );
        if (action === "advertir") {
          await connection.execute(
            `INSERT INTO medida_cuenta (id_usuario, id_reporte, id_tipo_medida, motivo, id_administrador)
             VALUES (?, ?, 1, ?, ?)`,
            [report.id_reportado, reportId, reason, adminId]
          );
        } else {
          await applySuspension(connection, report.id_reportado, days, reportId, reason, adminId);
        }
      }
      await logEvent(connection, adminId, "REPORTE_RESUELTO", reportId, { accion: action, dias: days || null });
      await connection.commit();
      const [people] = await pool.execute(
        "SELECT id_usuario, correo FROM usuario WHERE id_usuario IN (?, ?)",
        [report.id_reportante, report.id_reportado]
      );
      parties = people;
      reportedUser = report.id_reportado;
    } catch (error) {
      await connection.rollback();
      console.error("Error al resolver reporte:", error);
      return response.status(500).json({ message: "No fue posible resolver el reporte." });
    } finally {
      connection.release();
    }
    for (const person of parties) {
      const against = person.id_usuario === reportedUser && (action === "advertir" || action === "suspender");
      sendMail({
        to: person.correo,
        subject: "Actualización de tu reporte en CUIDARED",
        text: action === "desestimar" || action === "eliminar"
          ? "Revisamos el reporte del servicio y se cerró sin aplicar medidas."
          : against
            ? `Tras revisar el reporte, se aplicó una medida a tu cuenta${action === "suspender" ? ` (suspensión de ${days} días)` : " (advertencia)"}. Motivo: ${reason}`
            : "Revisamos el reporte y se resolvió. Gracias por ayudarnos a mantener CUIDARED seguro."
      });
    }
    return response.json({ message: "Reporte resuelto." });
  });
}

module.exports = { registerReportRoutes };
