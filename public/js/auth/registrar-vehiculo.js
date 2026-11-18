const params = new URLSearchParams(window.location.search);
const form = document.getElementById("vehicle-form");
const errorMessage = document.getElementById("error-message");
const successMessage = document.getElementById("success-message");
const platesInput = document.getElementById("placas_vehiculo");
const submitButton = form.querySelector('button[type="submit"]');

errorMessage.textContent = params.get("error") || "";
successMessage.textContent = params.get("success") || "";

platesInput.addEventListener("input", () => {
  platesInput.value = platesInput.value.toUpperCase().replace(/[^A-Z0-9 -]/g, "").slice(0, 10);
});

form.addEventListener("submit", (event) => {
  errorMessage.textContent = "";
  platesInput.value = platesInput.value.trim().toUpperCase();
  if (!form.checkValidity()) {
    event.preventDefault();
    form.reportValidity();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Guardando...";
});
