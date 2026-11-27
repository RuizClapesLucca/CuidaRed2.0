// Avisos en tiempo real. Abre un WebSocket solo si hay sesión y se reconecta solo.
// Los avisos se muestran con el estilo de la referencia (claro y oscuro).
(() => {
  if (window.__cuidaredRealtimeInit) return;
  window.__cuidaredRealtimeInit = true;

  const TYPES = ["success", "info", "warning", "error"];
  const MAX_RETRIES = 8;
  const ICONS = {
    success: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5M12 7.8v.1"/></svg>',
    warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v6M12 16.8v.1"/></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M9 9l6 6M15 9l-6 6"/></svg>'
  };

  function ensureContainer() {
    let container = document.querySelector(".cd-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "cd-toast-container";
      container.setAttribute("aria-live", "polite");
      document.body.appendChild(container);
    }
    return container;
  }

  // Muestra un aviso. El texto siempre se escribe con textContent (sin riesgo de inyección).
  function showToast({ type = "info", title = "", message = "", duration = 5000 } = {}) {
    const safeType = TYPES.includes(type) ? type : "info";
    const toast = document.createElement("div");
    toast.className = `cd-toast cd-toast--${safeType}`;
    toast.setAttribute("role", safeType === "error" ? "alert" : "status");
    toast.innerHTML = `
      <span class="cd-toast__icon">${ICONS[safeType]}</span>
      <div class="cd-toast__body"><strong></strong><p></p></div>
      <button class="cd-toast__close" type="button" aria-label="Cerrar aviso">&times;</button>
      <span class="cd-toast__bar"></span>`;
    toast.querySelector("strong").textContent = title;
    toast.querySelector("p").textContent = message;
    toast.querySelector("p").hidden = !message;

    let timer = null;
    const close = () => {
      if (toast.classList.contains("is-leaving")) return;
      clearTimeout(timer);
      toast.classList.add("is-leaving");
      toast.addEventListener("animationend", () => toast.remove(), { once: true });
      setTimeout(() => toast.remove(), 500); // respaldo si la animación no corre
    };
    const start = () => { timer = setTimeout(close, duration); };

    toast.querySelector(".cd-toast__close").addEventListener("click", close);
    toast.addEventListener("mouseenter", () => clearTimeout(timer));
    toast.addEventListener("mouseleave", start);
    toast.style.setProperty("--cd-duration", `${duration}ms`);

    ensureContainer().appendChild(toast);
    start();
    return toast;
  }
  window.cuidaredToast = showToast;

  // Estado de la conexión. Cada intento pide un ticket nuevo porque los tickets son de un solo uso.
  const MAX_BACKOFF_MS = 30000;
  const SESSION_ENDED_CODE = 4001; // el servidor lo envía al cerrar sesión o desactivar la cuenta
  let socket = null;
  let retries = 0;
  let reconnectTimer = null;
  let stopped = false;

  // Pide un ticket a la API. Devuelve null si la sesión ya no existe.
  async function requestConnectionInfo() {
    const response = await fetch("/api/realtime/ticket", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`Ticket rechazado (${response.status})`);
    return response.json();
  }

  // Reintenta con espera creciente (1 s, 2 s, 4 s... hasta 30 s).
  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(retries, 5));
    retries += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  async function connect() {
    if (stopped) return;
    // Ya hay una conexión abierta o en curso: no se duplica.
    if (socket && socket.readyState <= WebSocket.OPEN) return;

    let info;
    try {
      info = await requestConnectionInfo();
    } catch (error) {
      console.warn("No fue posible preparar los avisos:", error);
      scheduleReconnect();
      return;
    }
    if (!info) {
      // Sin sesión no hay avisos que escuchar: se deja de intentar.
      stopped = true;
      return;
    }

    // Sin URL pública se usa el mismo dominio de la página (desarrollo local).
    const base = info.url || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const url = new URL(base);
    url.searchParams.set("ticket", info.ticket);

    socket = new WebSocket(url.toString());
    socket.addEventListener("open", () => { retries = 0; });
    socket.addEventListener("message", (event) => {
      try {
        showToast(JSON.parse(event.data));
      } catch (error) {
        console.warn("Aviso con formato inválido:", error);
      }
    });
    socket.addEventListener("close", (event) => {
      socket = null;
      if (event.code === SESSION_ENDED_CODE) {
        stopped = true;
        return;
      }
      scheduleReconnect();
    });
  }

  // Al recuperar la red o volver a la pestaña se reconecta de inmediato, sin esperar la espera acumulada.
  function reconnectNow() {
    if (stopped || (socket && socket.readyState <= WebSocket.OPEN)) return;
    retries = 0;
    clearTimeout(reconnectTimer);
    connect();
  }
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reconnectNow();
  });

  connect();
})();
