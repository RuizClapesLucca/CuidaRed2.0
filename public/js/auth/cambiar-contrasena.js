// Envía el cambio de contraseña temporal y valida que la confirmación coincida.
const form = document.getElementById("password-form");
const message = document.getElementById("message");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  if (form.nueva.value !== form.confirmar.value) {
    message.textContent = "Las contraseñas nuevas no coinciden.";
    return;
  }
  try {
    const data = await apiJson("/api/cuenta/cambiar-contrasena", {
      method: "POST",
      body: { actual: form.actual.value, nueva: form.nueva.value }
    });
    window.location.href = data.redirect;
  } catch (error) {
    message.textContent = error.message;
  }
});
