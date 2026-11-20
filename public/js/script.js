(() => {
  // Lee la preferencia guardada y configura la clase de tema al cargar la página.
  const body = document.body;
  const themeToggleButton = document.getElementById("theme-toggle");
  const savedTheme = window.localStorage.getItem("cuidared-theme");

  if (savedTheme === "dark") {
    body.classList.add("theme-dark");
  }
  // Sincroniza el esquema nativo del navegador con el tema aplicado.
  document.documentElement.style.colorScheme =
    body.classList.contains("theme-dark") ? "dark" : "light";

  // Actualiza etiqueta y estados ARIA del botón según el tema actual.
  function syncThemeButton() {
    if (!themeToggleButton) return;
    const isDark = body.classList.contains("theme-dark");
    themeToggleButton.textContent = isDark ? "Modo claro" : "Modo oscuro";
    themeToggleButton.setAttribute("aria-pressed", String(isDark));
    themeToggleButton.setAttribute(
      "aria-label",
      isDark ? "Activar modo claro" : "Activar modo oscuro"
    );
  }

  // Alterna tema claro/oscuro y guarda la preferencia para próximas visitas.
  function toggleTheme() {
    body.classList.toggle("theme-dark");
    const isDark = body.classList.contains("theme-dark");
    window.localStorage.setItem("cuidared-theme", isDark ? "dark" : "light");
    // Actualiza controles nativos (como barras y campos) al cambiar de tema.
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    syncThemeButton();
  }

  if (themeToggleButton) {
    themeToggleButton.addEventListener("click", toggleTheme);
    syncThemeButton();
  }

  // Busca el bloque principal del hero y evita errores si la sección no existe.
  const hero = document.getElementById("hero");
  if (!hero) return;

  // Reúne todas las imágenes del carrusel para alternar la clase "active".
  const slides = Array.from(hero.querySelectorAll(".hero-carousel-image"));
  if (slides.length === 0) return;

  // El carrusel cambia exactamente cada 5 segundos.
  const intervalMs = 5000;
  let timerId = null;

  // Detecta la imagen activa inicial; si no hay una, activa la primera.
  let currentIndex = slides.findIndex((slide) => slide.classList.contains("active"));
  if (currentIndex === -1) {
    currentIndex = 0;
    slides[0].classList.add("active");
  }

  // Muestra una imagen y oculta las demás para que solo exista una activa.
  function showSlide(nextIndex) {
    slides[currentIndex].classList.remove("active");
    currentIndex = (nextIndex + slides.length) % slides.length;
    slides[currentIndex].classList.add("active");
  }

  // Programa el siguiente cambio cada 5 segundos.
  function scheduleNextSlide() {
    timerId = window.setTimeout(() => {
      showSlide(currentIndex + 1);
      scheduleNextSlide();
    }, intervalMs);
  }

  // Inicia la rotación automática.
  function startRotation() {
    if (timerId !== null) return;
    scheduleNextSlide();
  }

  // Detiene la rotación para pausar el carrusel mientras el usuario interactúa.
  function stopRotation() {
    if (timerId === null) return;
    window.clearTimeout(timerId);
    timerId = null;
  }

  // Pausa al pasar el cursor por el hero y reanuda cuando el cursor sale.
  hero.addEventListener("mouseenter", stopRotation);
  hero.addEventListener("mouseleave", startRotation);

  // Pausa cuando la pestaña está oculta y reanuda al volver para ahorrar recursos.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRotation();
      return;
    }
    startRotation();
  });

  // Arranca el carrusel con la primera imagen visible (img1) y rotación activa.
  startRotation();
})();
