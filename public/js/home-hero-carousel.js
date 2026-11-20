(() => {
  // Obtiene el hero y sus imágenes de fondo para evitar ejecutar lógica si falta el bloque.
  const hero = document.getElementById("hero");
  if (!hero) return;

  const slides = Array.from(hero.querySelectorAll(".hero-carousel-image"));
  if (slides.length === 0) return;

  const intervalMs = 500;
  let currentIndex = 0;
  let timerId = null;

  // Activa una sola imagen por turno y desactiva las demás usando la clase .active.
  function showSlide(nextIndex) {
    slides[currentIndex].classList.remove("active");
    currentIndex = (nextIndex + slides.length) % slides.length;
    slides[currentIndex].classList.add("active");
  }

  // Inicia la rotación automática cada 5 segundos.
  function startRotation() {
    if (timerId !== null) return;
    timerId = window.setInterval(() => {
      showSlide(currentIndex + 1);
    }, intervalMs);
  }

  // Pausa la rotación limpiando el intervalo activo.
  function stopRotation() {
    if (timerId === null) return;
    window.clearInterval(timerId);
    timerId = null;
  }

  // Pausa al pasar el cursor sobre el hero y reanuda cuando el cursor sale.
  hero.addEventListener("mouseenter", stopRotation);
  hero.addEventListener("mouseleave", startRotation);

  // Arranca el carrusel con img1 como imagen inicial visible.
  startRotation();
})();
