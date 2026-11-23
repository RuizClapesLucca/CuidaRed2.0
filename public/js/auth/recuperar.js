// Muestra errores del servidor y evita envíos duplicados al pedir el NIP.
const params = new URLSearchParams(window.location.search);
document.getElementById("message").textContent = params.get("error") || "";

const form = document.getElementById("recover-form");
const submitButton = form.querySelector('button[type="submit"]');
form.addEventListener("submit", (event) => {
  if (!form.checkValidity()) {
    event.preventDefault();
    form.reportValidity();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Enviando...";
});
