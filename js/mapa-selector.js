
const input = document.getElementById("ubicacionMaps");
const previewButton = document.getElementById("previewMaps");

if (input && previewButton && window.L) {
  let map = null;
  let marker = null;
  let selected = null;
  let returnFocus = null;

  const field = input.closest(".field");

  const selectorButton = document.createElement("button");
  selectorButton.type = "button";
  selectorButton.className = "map-select-button";
  selectorButton.textContent = "⌖ Seleccionar ubicación en el mapa";

  const selectedInfo = document.createElement("div");
  selectedInfo.className = "map-selected-info";
  selectedInfo.setAttribute("aria-live", "polite");

  input.type = "hidden";
  input.insertAdjacentElement("beforebegin", selectorButton);
  input.insertAdjacentElement("afterend", selectedInfo);

  const helper = field.querySelector(".maps-helper");

  if (helper) {
    helper.hidden = true;
  }

  previewButton.hidden = true;

  const overlay = document.createElement("div");
  overlay.className = "map-dialog-backdrop";
  overlay.id = "locationPickerOverlay";
  overlay.hidden = true;

  overlay.innerHTML = `
    <section class="map-dialog" role="dialog" aria-modal="true" aria-labelledby="mapDialogTitle">
      <header class="map-dialog-header">
        <div>
          <span>PRÉSTAMOS LA BENDICIÓN</span>
          <h2 id="mapDialogTitle">Ubicación del cliente</h2>
        </div>
        <button type="button" class="map-dialog-close" id="mapClose" aria-label="Cerrar mapa">×</button>
      </header>
      <div class="map-dialog-toolbar">
        <button type="button" class="map-gps-button" id="mapGPS">⌖ Usar mi ubicación actual</button>
        <div class="map-instructions">Toca el lugar exacto en el mapa o arrastra el marcador.</div>
      </div>
      <div id="clientLocationMap"></div>
      <div class="map-dialog-status" id="mapStatus" role="status">Selecciona un punto para guardar la ubicación.</div>
      <footer class="map-dialog-footer">
        <button type="button" class="map-clear-button" id="mapClear">Quitar ubicación</button>
        <div class="map-footer-right">
          <button type="button" class="map-cancel-button" id="mapCancel">Cancelar</button>
          <button type="button" class="map-save-button" id="mapSave" disabled>Guardar ubicación</button>
        </div>
      </footer>
    </section>
  `;

  document.body.append(overlay);

  const $ = id => document.getElementById(id);
  const defaultCenter = [23.6345, -102.5528];

  function parsePoint(value) {
    const match = value.trim().match(
      /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/
    );

    if (!match) return null;

    const lat = Number(match[1]);
    const lng = Number(match[2]);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }

    return { lat, lng };
  }

  function formattedPoint(point) {
    return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  }

  function updateInfo() {
    const value = input.value.trim();

    if (!value) {
      selectedInfo.textContent = "Sin ubicación registrada. Este dato es opcional.";
      return;
    }

    const point = parsePoint(value);

    selectedInfo.textContent = point
      ? `Ubicación guardada: ${formattedPoint(point)}`
      : "Hay un enlace de ubicación anterior. Puedes reemplazarlo seleccionando un punto.";
  }

  function setPoint(point, centerMap = false) {
    selected = {
      lat: Number(point.lat),
      lng: Number(point.lng)
    };

    if (marker) {
      marker.setLatLng([selected.lat, selected.lng]);
    } else {
      marker = L.marker(
        [selected.lat, selected.lng],
        { draggable: true, autoPan: true }
      ).addTo(map);

      marker.on("dragend", () => {
        setPoint(marker.getLatLng());
      });
    }

    if (centerMap) {
      map.setView([selected.lat, selected.lng], 18);
    }

    $("mapStatus").textContent =
      "Punto seleccionado: " + formattedPoint(selected);

    $("mapSave").disabled = false;
  }

  function initMap() {
    if (map) return;

    map = L.map("clientLocationMap", {
      zoomControl: true,
      tap: true
    }).setView(defaultCenter, 5);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    map.on("click", event => {
      setPoint(event.latlng);
    });
  }

  function closePicker() {
    overlay.hidden = true;
    document.body.style.overflow = "";
    $("mapGPS").disabled = false;

    if (returnFocus) {
      returnFocus.focus();
    }
  }

  function openPicker() {
    returnFocus = document.activeElement;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";

    initMap();

    if (marker) {
      map.removeLayer(marker);
      marker = null;
    }

    selected = null;
    $("mapSave").disabled = true;
    $("mapStatus").textContent =
      "Toca el lugar exacto del domicilio o utiliza tu ubicación actual.";

    const existingPoint = parsePoint(input.value);

    requestAnimationFrame(() => {
      map.invalidateSize();

      if (existingPoint) {
        setPoint(existingPoint, true);
      } else {
        map.setView(defaultCenter, 5);
      }
    });

    $("mapClose").focus();
  }

  selectorButton.addEventListener("click", openPicker);

  $("mapClose").addEventListener("click", closePicker);
  $("mapCancel").addEventListener("click", closePicker);

  $("mapGPS").addEventListener("click", () => {
    if (!navigator.geolocation) {
      $("mapStatus").textContent =
        "Este dispositivo no permite obtener su ubicación.";
      return;
    }

    if (!window.isSecureContext) {
      $("mapStatus").textContent =
        "Para utilizar el GPS, abre la aplicación mediante HTTPS o localhost.";
      return;
    }

    const button = $("mapGPS");

    button.disabled = true;
    button.textContent = "Buscando ubicación...";
    $("mapStatus").textContent =
      "Solicitando permiso y buscando tu ubicación actual...";

    navigator.geolocation.getCurrentPosition(
      position => {
        if (overlay.hidden) return;

        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        setPoint(point, true);

        const accuracy = Math.round(position.coords.accuracy);

        $("mapStatus").textContent =
          `Ubicación encontrada. Precisión aproximada: ${accuracy} metros. Ajusta el marcador si es necesario.`;

        button.disabled = false;
        button.textContent = "⌖ Usar mi ubicación actual";
      },
      error => {
        if (overlay.hidden) return;

        const messages = {
          1: "No se concedió permiso de ubicación. Puedes seleccionar el punto manualmente.",
          2: "No fue posible determinar la ubicación. Selecciónala manualmente.",
          3: "Se agotó el tiempo para obtener la ubicación. Intenta de nuevo."
        };

        $("mapStatus").textContent =
          messages[error.code] || "No se pudo obtener tu ubicación.";

        button.disabled = false;
        button.textContent = "⌖ Usar mi ubicación actual";
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  });

  $("mapSave").addEventListener("click", () => {
    if (!selected) return;

    input.value = formattedPoint(selected);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    updateInfo();
    closePicker();
  });

  $("mapClear").addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    updateInfo();
    closePicker();
  });

  overlay.addEventListener("click", event => {
    if (event.target === overlay) {
      closePicker();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || overlay.hidden) return;

    event.stopImmediatePropagation();
    closePicker();
  }, true);

  document.getElementById("newClient")?.addEventListener("click", () => {
    requestAnimationFrame(updateInfo);
  });

  document.getElementById("clientsList")?.addEventListener("click", event => {
    if (event.target.closest(".action.edit")) {
      requestAnimationFrame(updateInfo);
    }
  });

  updateInfo();
} else {
  console.error("No se pudo inicializar el selector de ubicaciones.");
}
