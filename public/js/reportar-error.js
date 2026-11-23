// Envía el reporte técnico (texto y captura opcional) como multipart y muestra el número de ticket.
const message = document.getElementById("message");
const form = document.getElementById("ticket-form");
const captureInput = document.getElementById("captura");
const submitButton = form.querySelector('button[type="submit"]');
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  message.classList.remove("form-message--success");
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const capture = captureInput.files[0];
  if (capture && capture.size > MAX_CAPTURE_BYTES) {
    message.textContent = "La captura debe pesar menos de 5 MB.";
    message.classList.add("form-message--error");
    return;
  }
  submitButton.disabled = true;
  try {
    const body = new FormData();
    body.append("modulo", form.modulo.value);
    body.append("descripcion", form.descripcion.value.trim());
    if (capture) body.append("captura", capture);
    const data = await apiJson("/api/tickets", { method: "POST", body });
    message.textContent = data.message;
    message.classList.remove("form-message--error");
    form.reset();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("form-message--error");
  } finally {
    submitButton.disabled = false;
  }
});
