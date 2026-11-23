// Muestra errores del servidor y evita envíos duplicados del código TOTP.
const params = new URLSearchParams(window.location.search);
const message = document.getElementById("message");
message.textContent = params.get("error") || "";

const form = document.getElementById("totp-form");
const codeInput = document.getElementById("codigo");
const submitButton = form.querySelector('button[type="submit"]');

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
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
