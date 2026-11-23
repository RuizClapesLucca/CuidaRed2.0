// Utilidades comunes de las pantallas nuevas: peticiones JSON y escape de texto.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));
}

// Devuelve el JSON de la respuesta o lanza un error con el mensaje del servidor.
async function apiJson(url, options = {}) {
  const init = { ...options };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(url, init);
  if (response.status === 401) {
    window.location.href = "/auth/iniciar-sesion.html";
    throw new Error("Tu sesión expiró. Inicia sesión de nuevo.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "La operación no pudo completarse.");
  return data;
}

// Solo permite regresar a rutas internas de la aplicación.
function safeReturnPath(value) {
  const text = String(value || "");
  return text.startsWith("/") && !text.startsWith("//") ? text : "/Modulo1.html";
}
