// Cancela la solicitud con DELETE y JSON. El servidor aplica la contraseña, el plazo de 2 horas y el motivo.
const params = new URLSearchParams(window.location.search);
const requestId = params.get("id");
const message = document.getElementById("message");
const form = document.getElementById("cancel-form");
const submitButton = form.querySelector('button[type="submit"]');

if (!/^\d+$/.test(requestId || "")) {
  message.textContent = "No se encontró la solicitud.";
  submitButton.disabled = true;
} else {
  apiJson("/api/motivos-cancelacion")
    .then((data) => {
      document.getElementById("motivo").innerHTML = data.reasons
        .map((reason) => `<option value="${reason.id}">${escapeHtml(reason.nombre)}</option>`)
        .join("");
    })
    .catch((error) => { message.textContent = error.message; });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Cancelando...";
  try {
    const response = await fetch(`/api/solicitudes/${requestId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: form.password.value,
        id_motivo: Number(form.id_motivo.value),
        comentario: form.comentario.value.trim()
      })
    });
    if (response.status === 401) {
      window.location.href = "/auth/iniciar-sesion.html";
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || "No fue posible cancelar la solicitud.");
    }
    window.location.href = "/solicitante/solicitar-servicio.html";
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = "Cancelar solicitud";
  }
});
