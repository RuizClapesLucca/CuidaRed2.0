/**
 * Ejecuta una petición HTTP y convierte su respuesta en un objeto JavaScript.
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
