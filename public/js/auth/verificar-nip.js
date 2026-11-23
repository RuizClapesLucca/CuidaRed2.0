// Muestra el resultado de la verificación y evita envíos duplicados del NIP.
const params = new URLSearchParams(window.location.search);
const message = document.getElementById("message");
const error = params.get("error") || "";
message.textContent = error || params.get("success") || "";
message.classList.toggle("form-message--error", Boolean(error));

const form = document.getElementById("nip-form");
const nipInput = document.getElementById("nip");
const submitButton = form.querySelector('button[type="submit"]');

// Solo deja pasar dígitos; el servidor vuelve a validar.
nipInput.addEventListener("input", () => {
  nipInput.value = nipInput.value.replace(/\D/g, "").slice(0, 6);
});

form.addEventListener("submit", (event) => {
  if (!form.checkValidity()) {
    event.preventDefault();
    form.reportValidity();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Verificando...";
});
