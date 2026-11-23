// Muestra el resultado, valida que las contraseñas coincidan antes de enviar y evita envíos duplicados.
const params = new URLSearchParams(window.location.search);
const message = document.getElementById("message");
const error = params.get("error") || "";
message.textContent = error || params.get("success") || "";
message.classList.toggle("form-message--error", Boolean(error));

const form = document.getElementById("reset-form");
const nipInput = document.getElementById("nip");
const password = document.getElementById("password");
const confirmar = document.getElementById("confirmar");
const submitButton = form.querySelector('button[type="submit"]');

nipInput.addEventListener("input", () => {
  nipInput.value = nipInput.value.replace(/\D/g, "").slice(0, 6);
});

form.addEventListener("submit", (event) => {
  if (!form.checkValidity()) {
    event.preventDefault();
    form.reportValidity();
    return;
  }
  if (password.value !== confirmar.value) {
    event.preventDefault();
    message.textContent = "Las contraseñas no coinciden.";
    message.classList.add("form-message--error");
    confirmar.focus();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Guardando...";
});
