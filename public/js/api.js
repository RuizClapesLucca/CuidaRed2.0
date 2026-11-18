 /* Ejecuta una petición HTTP y convierte su respuesta en un objeto JavaScript.
 * También concentra el manejo de errores para que todos los módulos muestren
 * el mensaje enviado por el servidor y puedan consultar el código HTTP.
 */
async function requestJson(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  let result;
  try {
    result = contentType.includes("application/json") ? JSON.parse(body) : { message: body };
  } catch {
    result = { message: "El servidor devolvió una respuesta inesperada." };
  }

  if (!response.ok) {
    const error = new Error(result.message || "La operación no pudo completarse.");
    error.status = response.status;
    throw error;
  }
  return result;
}


/**
 * Las fechas se guardan en UTC para que sean un solo momento real. Estas funciones
 * convierten entre la hora local de quien usa la página y UTC, así cada persona
 * ve y registra las horas en su propia zona horaria.
 */
function localToUtcSchedule(date, time) {
  const value = new Date(`${date}T${time}`);
  if (Number.isNaN(value.getTime())) return { fecha_programada: date, hora_programada: time };
  return {
    fecha_programada: value.toISOString().slice(0, 10),
    hora_programada: value.toISOString().slice(11, 16)
  };
}

function utcToLocalSchedule(fecha, hora) {
  const value = new Date(`${fecha}T${String(hora).slice(0, 5)}:00Z`);
  if (Number.isNaN(value.getTime())) return { fecha, hora };
  const pad = (number) => String(number).padStart(2, "0");
  return {
    fecha: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    hora: `${pad(value.getHours())}:${pad(value.getMinutes())}`
  };
}

function localizeSchedule(item) {
  const local = utcToLocalSchedule(item.fecha, item.hora);
  return { ...item, fecha: local.fecha, hora: local.hora };
}
