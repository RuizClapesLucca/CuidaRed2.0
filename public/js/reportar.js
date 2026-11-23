// Envía la incidencia como multipart. El servidor vuelve a validar archivos, plazos y permisos.
const params = new URLSearchParams(window.location.search);
const serviceId = params.get("servicio");
const backPath = safeReturnPath(params.get("volver"));
const message = document.getElementById("message");
const form = document.getElementById("report-form");
const motivo = document.getElementById("motivo");
const files = document.getElementById("evidencias");
const submitButton = form.querySelector('button[type="submit"]');
document.getElementById("back-link").href = backPath;

const MAX_FILES = 3;
const MAX_BYTES = 10 * 1024 * 1024;

if (!/^\d+$/.test(serviceId || "")) {
  message.textContent = "No se encontró el servicio. Vuelve a la lista e inténtalo de nuevo.";
  form.querySelectorAll("input, select, textarea, button").forEach((element) => { element.disabled = true; });
} else {
  apiJson("/api/motivos-reporte")
    .then((data) => {
      motivo.innerHTML = data.reasons
        .map((reason) => `<option value="${reason.id}">${escapeHtml(reason.nombre)}</option>`)
        .join("");
    })
    .catch((error) => { message.textContent = error.message; });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  if (files.files.length > MAX_FILES) {
    message.textContent = "Adjunta como máximo 3 archivos.";
    return;
  }
  for (const file of files.files) {
    if (file.size > MAX_BYTES) {
      message.textContent = `El archivo ${file.name} supera los 10 MB.`;
      return;
    }
  }
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Enviando...";
  try {
    const body = new FormData(form);
    body.delete("evidencias");
    for (const file of files.files) body.append("evidencias", file);
    const data = await apiJson(`/api/servicios/${serviceId}/reportes`, { method: "POST", body });
    window.alert(data.message);
    window.location.href = backPath;
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = "Enviar reporte";
  }
});
