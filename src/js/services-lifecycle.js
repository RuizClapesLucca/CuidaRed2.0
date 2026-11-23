// Reglas de ciclo de vida compartidas por las rutas de solicitudes y postulaciones:
// cierre de servicios (de ambas partes o automático a las 24 h) y expiración de
// postulaciones sin respuesta. Todas las fechas se comparan en UTC.
const POSTULATION_EXPIRE_SQL = "INTERVAL '24 hours'";

// Termina el servicio: la solicitud pasa a Terminado y se suma a la reputación
// del prestador. Debe llamarse dentro de una transacción con la fila bloqueada.
async function finalizeService(connection, serviceId) {
  const [rows] = await connection.execute(
    "SELECT id_peticion, id_postulacion FROM servicio WHERE id_servicio = ?",
    [serviceId]
  );
  const service = rows[0];
  await connection.execute(
    `UPDATE servicio
     SET fecha_terminado = (NOW() AT TIME ZONE 'UTC'), cierre_prestador = TRUE, cierre_buscador = TRUE
     WHERE id_servicio = ?`,
    [serviceId]
  );
  await connection.execute(
    `UPDATE peticion
     SET id_estado_peticion = 3, fecha_terminado = (NOW() AT TIME ZONE 'UTC')
     WHERE id_peticion = ?`,
    [service.id_peticion]
  );
  await connection.execute(
    `INSERT INTO reputacion (id_usuario, servicios_terminados)
     VALUES (
       (SELECT pp2.id_usuario
        FROM postulacion po2
        JOIN perfil_prestador pp2 ON pp2.id_perfil = po2.id_perfil
        WHERE po2.id_postulacion = ?),
       1
     )
     ON CONFLICT (id_usuario) DO UPDATE SET servicios_terminados = reputacion.servicios_terminados + 1`,
    [service.id_postulacion]
  );
}

// Cierra automáticamente los servicios donde una parte pidió terminar y la otra
// no respondió en 24 horas.
async function closeExpiredRequests(pool) {
  const [due] = await pool.execute(
    `SELECT s.id_servicio
     FROM servicio s
     JOIN peticion p ON p.id_peticion = s.id_peticion
     WHERE p.id_estado_peticion = 2
       AND s.fecha_solicitud_cierre IS NOT NULL
       AND s.fecha_solicitud_cierre <= ((NOW() AT TIME ZONE 'UTC') - ${POSTULATION_EXPIRE_SQL})`
  );
  for (const row of due) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // Se vuelve a comprobar el estado con la fila bloqueada por si cambió mientras tanto.
      const [locked] = await connection.execute(
        `SELECT s.id_servicio FROM servicio s JOIN peticion p ON p.id_peticion = s.id_peticion
         WHERE s.id_servicio = ? AND p.id_estado_peticion = 2
         FOR UPDATE OF s`,
        [row.id_servicio]
      );
      if (locked.length > 0) await finalizeService(connection, row.id_servicio);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error("Error al cerrar servicio automáticamente:", error);
    } finally {
      connection.release();
    }
  }
}

// Marca como Expirada cualquier postulación sin respuesta después de 24 horas.
async function expirePostulations(pool) {
  await pool.execute(
    `UPDATE postulacion
     SET id_estado_postulacion = 6, fecha_decision = (NOW() AT TIME ZONE 'UTC')
     WHERE id_estado_postulacion = 1
       AND fecha_postulacion <= ((NOW() AT TIME ZONE 'UTC') - ${POSTULATION_EXPIRE_SQL})
       AND NOT EXISTS (SELECT 1 FROM servicio s WHERE s.id_postulacion = postulacion.id_postulacion)`
  );
}

module.exports = { finalizeService, closeExpiredRequests, expirePostulations };
