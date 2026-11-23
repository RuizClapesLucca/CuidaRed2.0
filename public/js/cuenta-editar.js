// Muestra los datos de la cuenta y gestiona el cambio de correo o teléfono en dos pasos.
const message = document.getElementById("message");
const requestForm = document.getElementById("request-form");
const confirmForm = document.getElementById("confirm-form");
const showMessage = (text, isError = true) => {
  message.textContent = text;
  message.classList.toggle("form-message--error", isError);
};

apiJson("/api/cuenta")
  .then((data) => {
    document.getElementById("nombre").textContent = data.nombre_completo;
    document.getElementById("nacimiento").textContent = data.fecha_nacimiento;
    document.getElementById("correo").textContent = data.correo;
    document.getElementById("telefono").textContent = data.telefono_ultimos_digitos;
  })
  .catch((error) => showMessage(error.message));

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requestForm.checkValidity()) {
    requestForm.reportValidity();
    return;
  }
  try {
    const data = await apiJson("/api/cuenta/editar", {
      method: "POST",
      body: {
        tipo: requestForm.tipo.value,
        valor: requestForm.valor.value.trim(),
        password: requestForm.password.value
      }
    });
    showMessage(data.message, false);
    confirmForm.hidden = false;
    requestForm.password.value = "";
  } catch (error) {
    showMessage(error.message);
  }
});

confirmForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirmForm.checkValidity()) {
    confirmForm.reportValidity();
    return;
  }
  try {
    const data = await apiJson("/api/cuenta/editar/confirmar", {
      method: "POST",
      body: { nip: confirmForm.nip.value }
    });
    showMessage(data.message, false);
    confirmForm.hidden = true;
    confirmForm.nip.value = "";
    setTimeout(() => window.location.reload(), 800);
  } catch (error) {
    showMessage(error.message);
  }
});
