// Componente de inicio de sesión: muestra errores recibidos y evita envíos
// duplicados después de validar los datos básicos del formulario.
const params = new URLSearchParams(window.location.search);
const form = document.getElementById("login-form");
const message = document.getElementById("message");
const identifierInput = document.getElementById("correo");
const passwordInput = document.getElementById("password");
const submitButton = form.querySelector('button[type="submit"]');
// Recupera el error colocado por el servidor en la URL después de un login
// fallido y lo muestra sin insertar contenido HTML recibido externamente.
message.textContent = params.get("error") || "";

// Valida y normaliza los datos antes de permitir el envío. El botón se
// deshabilita al final para evitar dos solicitudes de inicio de sesión.
form.addEventListener("submit", (event) => {
  message.textContent = "";
  identifierInput.value = identifierInput.value.trim();
  if (identifierInput.value.includes("@")) {
    identifierInput.value = identifierInput.value.toLowerCase();
  }
  if (!form.checkValidity()) {
    event.preventDefault();
    form.reportValidity();
    return;
  }
  if (passwordInput.value.length < 8) {
    event.preventDefault();
    message.textContent = "La contraseña debe tener al menos 8 caracteres.";
    passwordInput.focus();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Iniciando sesión...";
});
