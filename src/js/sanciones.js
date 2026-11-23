// Suspensiones de cuenta: se aplican desde el panel de incidencias y se levantan
// solas cuando vence el plazo, al intentar iniciar sesión.
const STATE_ACTIVE = 2;
const STATE_SUSPENDED = 4;
const MEASURE_SUSPENSION = 2;

// Aplica una suspensión dentro de la transacción del administrador.
async function applySuspension(connection, userId, days, reportId, reason, adminId) {
  await connection.execute(
    `INSERT INTO medida_cuenta
       (id_usuario, id_reporte, id_tipo_medida, dias_suspension, motivo, id_administrador, fecha_fin)
     VALUES (?, ?, ?, ?, ?, ?, (NOW() AT TIME ZONE 'UTC') + make_interval(days => ?::int))`,
    [userId, reportId, MEASURE_SUSPENSION, days, reason, adminId, days]
  );
  await connection.execute(
    "UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ? AND id_estado_cuenta = ?",
    [STATE_SUSPENDED, userId, STATE_ACTIVE]
  );
}

// Devuelve { restored: true } si la suspensión ya venció (y reactiva la cuenta),
// o { restored: false, until } si sigue vigente.
async function restoreIfSuspensionEnded(pool, userId) {
  const [rows] = await pool.execute(
    `SELECT fecha_fin, (fecha_fin > (NOW() AT TIME ZONE 'UTC')) AS vigente
     FROM medida_cuenta
     WHERE id_usuario = ? AND id_tipo_medida = ?
     ORDER BY id_medida DESC
     LIMIT 1`,
    [userId, MEASURE_SUSPENSION]
  );
  const latest = rows[0];
  if (latest && latest.vigente) {
    return { restored: false, until: latest.fecha_fin };
  }
  await pool.execute(
    "UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ? AND id_estado_cuenta = ?",
    [STATE_ACTIVE, userId, STATE_SUSPENDED]
  );
  return { restored: true };
}

module.exports = { applySuspension, restoreIfSuspensionEnded, STATE_SUSPENDED };
