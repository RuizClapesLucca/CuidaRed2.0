// Componente de registro: muestra errores, valida datos básicos y configura
// límites de edad antes de enviar el formulario al servidor.
const params = new URLSearchParams(window.location.search);
const form = document.getElementById("register-form");
const message = document.getElementById("message");
const submitButton = form.querySelector('button[type="submit"]');
const phoneInput = document.getElementById("telefono");
const passwordInput = document.getElementById("password");
const nameInput = document.getElementById("nombre_completo");
const providerFields = document.getElementById("provider-fields");
const providerInputs = providerFields.querySelectorAll("input, textarea, select");
const roleInputs = form.querySelectorAll('input[name="rol"]');
const curpInput = document.getElementById("curp");
const emergencyPhoneInput = document.getElementById("contacto_emergencia_telefono");
const platesInput = document.getElementById("placas_vehiculo");
const vehicleChoice = document.getElementById("cuenta_con_coche");
const vehicleFields = document.getElementById("vehicle-fields");
const vehicleInputs = vehicleFields.querySelectorAll("input");
// El servidor redirige con un parámetro de error para conservar el mensaje
// después de una validación fallida o de un correo ya registrado.
message.textContent = params.get("error") || "";

// Calcula la fecha máxima permitida para una persona de al menos 18 años.
const maximumBirthDate = new Date();
maximumBirthDate.setFullYear(maximumBirthDate.getFullYear() - 18);
document.getElementById("fecha_nacimiento").max = maximumBirthDate.toISOString().slice(0, 10);

// Estos listeners normalizan datos mientras se escriben y evitan caracteres
// inválidos antes de que el formulario llegue al servidor.
phoneInput.addEventListener("input", () => {
  phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 10);
});

emergencyPhoneInput.addEventListener("input", () => {
  emergencyPhoneInput.value = emergencyPhoneInput.value.replace(/\D/g, "").slice(0, 10);
});

curpInput.addEventListener("input", () => {
  curpInput.value = curpInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18);
});

platesInput.addEventListener("input", () => {
  platesInput.value = platesInput.value.toUpperCase().replace(/[^A-Z0-9 -]/g, "").slice(0, 10);
});

function updateProviderFields() {
  const isProvider = form.querySelector('input[name="rol"]:checked')?.value === "prestador";
  providerFields.hidden = !isProvider;
  providerInputs.forEach((input) => {
    input.required = isProvider && (input === vehicleChoice || !vehicleFields.contains(input));
  });
  updateVehicleFields();
}

function updateVehicleFields() {
  const hasVehicle = vehicleChoice.value === "si";
  vehicleFields.hidden = !hasVehicle;
  vehicleInputs.forEach((input) => {
    input.required = form.querySelector('input[name="rol"]:checked')?.value === "prestador" && hasVehicle;
  });
  if (!hasVehicle) {
    vehicleInputs.forEach((input) => { input.value = ""; });
  }
}

// El rol determina qué datos adicionales son obligatorios; el vehículo solo
// se solicita cuando la persona prestadora confirma que cuenta con uno.
roleInputs.forEach((input) => input.addEventListener("change", updateProviderFields));
vehicleChoice.addEventListener("change", updateVehicleFields);
updateProviderFields();

// Normaliza nombre y correo, ejecuta la validación HTML5 y evita envíos
// duplicados mientras el servidor procesa el registro.
form.addEventListener("submit", (event) => {
  message.textContent = "";
  nameInput.value = nameInput.value.trim().replace(/\s+/g, " ");
  document.getElementById("correo").value = document.getElementById("correo").value.trim().toLowerCase();

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
  submitButton.textContent = "Registrando...";
});
