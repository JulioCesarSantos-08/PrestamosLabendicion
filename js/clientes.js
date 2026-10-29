
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let clients = [];
let employees = [];
let editingId = null;
let saving = false;
let unsubscribeClients = null;
let unsubscribeUsers = null;
let unsubscribeProfile = null;

function normalizeName(value) {
  return value.normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("es-MX");
}

function normalizeText(value) {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function coordinates(value) {
  const match = value.trim().match(
    /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/
  );

  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return `${lat},${lng}`;
}

function validMapsUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.port) return null;

    const host = url.hostname.toLowerCase();

    const isGoogle =
      ["google.com", "www.google.com", "maps.google.com"].includes(host);

    const isShort =
      ["maps.app.goo.gl", "goo.gl"].includes(host);

    if (isGoogle && !url.pathname.startsWith("/maps")) {
      return null;
    }

    if (host === "goo.gl" && !url.pathname.startsWith("/maps/")) {
      return null;
    }

    if (!isGoogle && !isShort) return null;

    if (value.length > 1800) return null;

    return url.href;
  } catch {
    return null;
  }
}

function extractCoordinates(value) {
  const direct = coordinates(value);
  if (direct) return direct;

  const url = validMapsUrl(value);
  if (!url) return null;

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const queryValues = [
    parsed.searchParams.get("q"),
    parsed.searchParams.get("query"),
    parsed.searchParams.get("destination"),
    parsed.searchParams.get("ll")
  ];

  for (const query of queryValues) {
    if (query && coordinates(query)) {
      return coordinates(query);
    }
  }

  const at = parsed.pathname.match(
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
  );

  if (at) {
    const point = coordinates(`${at[1]},${at[2]}`);
    if (point) return point;
  }

  const marker = parsed.href.match(
    /!3d(-?\d+(?:\.\d+)?)(?:!4d)(-?\d+(?:\.\d+)?)/
  );

  if (marker) {
    const point = coordinates(`${marker[1]},${marker[2]}`);
    if (point) return point;
  }

  return null;
}

function validLocation(value) {
  if (!value.trim()) return true;
  return Boolean(coordinates(value) || validMapsUrl(value));
}

function mapsDestination(value) {
  const point = extractCoordinates(value);

  if (point) {
    return "https://www.google.com/maps/dir/?api=1" +
      "&destination=" + encodeURIComponent(point) +
      "&travelmode=driving&dir_action=navigate";
  }

  return validMapsUrl(value);
}

function openMaps(value) {
  const url = mapsDestination(value);

  if (!url) {
    toast("La ubicación no tiene un formato válido.");
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function toast(message) {
  const element = $("toast");

  element.textContent = message;
  element.classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 3500);
}

function make(tag, className = "", content) {
  const element = document.createElement(tag);
  element.className = className;

  if (content !== undefined) {
    element.textContent = String(content);
  }

  return element;
}

function closeMenu() {
  $("sidebar").classList.remove("open");
  $("overlay").classList.remove("show");
}

function openModal(client = null) {
  editingId = client ? client.id : null;

  $("clientForm").reset();
  $("formMessage").textContent = "";
  $("modalTitle").textContent = client ? "Editar cliente" : "Registrar cliente";
  $("saveButton").textContent = client ? "Guardar cambios" : "Guardar cliente";

  $("telefono").disabled = Boolean(client);

  $("phoneHint").textContent = client
    ? "El teléfono identifica este expediente y no puede cambiarse aquí."
    : "Número mexicano de 10 dígitos.";

  renderEmployeeOptions(client?.empleadoId || "");

  if (client) {
    $("nombre").value = client.nombre || "";
    $("telefono").value = client.telefono || "";
    $("domicilio").value = client.domicilio || "";
    $("referencias").value = client.referencias || "";
    $("observaciones").value = client.observaciones || "";
    $("ubicacionMaps").value = client.ubicacionMaps || "";
  }

  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
  $("nombre").focus();
}

function closeModal() {
  if (saving) return;

  $("modal").hidden = true;
  document.body.style.overflow = "";
  editingId = null;
}

function renderEmployeeOptions(selected = null) {
  const select = $("empleado");
  const value = selected !== null ? selected : select.value;

  select.replaceChildren(new Option("Sin asignar", ""));

  const activeEmployees = employees
    .filter(user => user.rol === "empleado" && user.estado === "activo")
    .sort((a, b) =>
      (a.nombre || "").localeCompare(b.nombre || "", "es")
    );

  for (const employee of activeEmployees) {
    select.add(new Option(employee.nombre || "EMPLEADO", employee.uid));
  }

  if (value && !activeEmployees.some(user => user.uid === value)) {
    select.add(new Option("Cobrador no disponible — reasignar", value));
  }

  select.value = value || "";
}

function employeeName(id) {
  if (!id) return "Sin cobrador asignado";

  return employees.find(user => user.uid === id)?.nombre ||
    "Cobrador no disponible";
}

function render() {
  const assigned = clients.filter(client =>
    Boolean(client.empleadoId)
  ).length;

  $("totalClients").textContent = clients.length;
  $("assignedClients").textContent = assigned;
  $("unassignedClients").textContent = clients.length - assigned;

  const search = $("search").value.trim().toLocaleUpperCase("es-MX");
  const filter = $("filter").value;

  const filtered = clients.filter(client => {
    const text = [
      client.nombre,
      client.telefono,
      client.domicilio,
      client.referencias
    ].join(" ").toLocaleUpperCase("es-MX");

    if (!text.includes(search)) return false;

    if (filter === "asignados") return Boolean(client.empleadoId);
    if (filter === "sinAsignar") return !client.empleadoId;
    if (filter === "conMapa") return Boolean(client.ubicacionMaps);
    if (filter === "sinMapa") return !client.ubicacionMaps;

    return true;
  });

  filtered.sort((a, b) =>
    (a.nombre || "").localeCompare(b.nombre || "", "es")
  );

  $("resultCount").textContent = `${filtered.length} clientes encontrados`;

  const container = $("clientsList");
  container.replaceChildren();

  if (!filtered.length) {
    container.append(
      make("div", "empty", "No se encontraron clientes.")
    );
    return;
  }

  for (const client of filtered) {
    const row = make("article", "client-row");

    const avatar = make(
      "div",
      "client-avatar",
      (client.nombre || "?").charAt(0)
    );

    const details = make("div", "client-details");
    const actions = make("div", "client-actions");

    details.append(
      make("strong", "", client.nombre || "SIN NOMBRE")
    );

    details.append(
      make("small", "", `Tel. ${client.telefono || "Sin teléfono"}`)
    );

    details.append(
      make("small", "", client.domicilio || "Sin domicilio")
    );

    const tag = make(
      "span",
      "client-tag" + (client.empleadoId ? " assigned" : ""),
      employeeName(client.empleadoId)
    );

    details.append(tag);

    if (client.ubicacionMaps && validLocation(client.ubicacionMaps)) {
      details.append(
        make("span", "maps-tag", "📍 Ubicación disponible")
      );
    }

    const edit = make("button", "action edit", "Editar");
    edit.type = "button";
    edit.addEventListener("click", () => openModal(client));

    actions.append(edit);

    if (/^\d{10}$/.test(client.telefono || "")) {
      const whatsapp = make("a", "action", "WhatsApp");
      whatsapp.href = `https://wa.me/52${client.telefono}`;
      whatsapp.target = "_blank";
      whatsapp.rel = "noopener noreferrer";
      actions.append(whatsapp);
    }

    if (
      client.ubicacionMaps &&
      validLocation(client.ubicacionMaps)
    ) {
      const directions = make(
        "a",
        "action directions",
        "⌖ Cómo llegar"
      );

      directions.href = mapsDestination(client.ubicacionMaps);
      directions.target = "_blank";
      directions.rel = "noopener noreferrer";

      actions.append(directions);
    }

    row.append(avatar, details, actions);
    container.append(row);
  }
}

async function saveClient(event) {
  event.preventDefault();

  if (saving || !currentUser) return;

  const nombre = normalizeName($("nombre").value);
  const telefono = $("telefono").value.replace(/\D/g, "");
  const domicilio = normalizeText($("domicilio").value);
  const referencias = normalizeText($("referencias").value);
  const observaciones = normalizeText($("observaciones").value);
  const empleadoId = $("empleado").value;
  const ubicacionMaps = $("ubicacionMaps").value.trim();

  if (nombre.length < 12 || nombre.length > 120) {
    $("formMessage").textContent =
      "El nombre completo debe tener entre 12 y 120 caracteres.";
    return;
  }

  if (!/^\d{10}$/.test(telefono)) {
    $("formMessage").textContent = "Ingresa un teléfono de 10 dígitos.";
    return;
  }

  if (domicilio.length < 8 || domicilio.length > 300) {
    $("formMessage").textContent =
      "Ingresa un domicilio de 8 a 300 caracteres.";
    return;
  }

  if (!validLocation(ubicacionMaps)) {
    $("formMessage").textContent =
      "Ingresa un enlace válido de Google Maps o coordenadas. También puedes dejarlo vacío.";
    return;
  }

  if (empleadoId && !employees.some(user =>
    user.uid === empleadoId &&
    user.estado === "activo" &&
    user.rol === "empleado"
  )) {
    $("formMessage").textContent = "Selecciona un cobrador activo.";
    return;
  }

  saving = true;
  $("saveButton").disabled = true;
  $("saveButton").textContent = "Guardando...";
  $("formMessage").textContent = "";

  try {
    const payload = {
      nombre,
      telefono,
      domicilio,
      referencias,
      observaciones,
      empleadoId,
      ubicacionMaps
    };

    if (editingId) {
      await updateDoc(doc(db, "clientes", editingId), {
        ...payload,
        actualizadoEn: serverTimestamp(),
        actualizadoPor: currentUser.uid
      });

      toast("Cliente actualizado correctamente.");
    } else {
      const reference = doc(db, "clientes", telefono);
      const existing = await getDoc(reference);

      if (existing.exists()) {
        throw new Error("Ya existe un cliente con este teléfono.");
      }

      await setDoc(reference, {
        ...payload,
        creadoEn: serverTimestamp(),
        creadoPor: currentUser.uid
      });

      toast("Cliente registrado correctamente.");
    }

    saving = false;
    closeModal();
  } catch (error) {
    $("formMessage").textContent =
      error.code === "permission-denied"
        ? "Firebase rechazó el registro. Comprueba los permisos o si ya existe el teléfono."
        : `No se pudo guardar: ${error.message}`;
  } finally {
    saving = false;
    $("saveButton").disabled = false;
    $("saveButton").textContent =
      editingId ? "Guardar cambios" : "Guardar cliente";
  }
}

$("menuButton").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("overlay").classList.add("show");
});

$("overlay").addEventListener("click", closeMenu);

$("newClient").addEventListener("click", () => {
  openModal();
});

$("closeModal").addEventListener("click", closeModal);
$("cancelButton").addEventListener("click", closeModal);
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);
$("clientForm").addEventListener("submit", saveClient);

$("nombre").addEventListener("input", event => {
  event.target.value = event.target.value.toLocaleUpperCase("es-MX");
});

$("telefono").addEventListener("input", event => {
  event.target.value = event.target.value
    .replace(/\D/g, "")
    .slice(0, 10);
});

$("previewMaps").addEventListener("click", () => {
  const value = $("ubicacionMaps").value.trim();

  if (!value) {
    $("formMessage").textContent =
      "Primero pega un enlace de Google Maps o unas coordenadas.";
    return;
  }

  if (!validLocation(value)) {
    $("formMessage").textContent = "La ubicación no es válida.";
    return;
  }

  $("formMessage").textContent = "";
  openMaps(value);
});

$("logout").addEventListener("click", async () => {
  await signOut(auth);
  location.replace("index.html");
});

$("modal").addEventListener("click", event => {
  if (event.target === $("modal")) closeModal();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("modal").hidden) {
    closeModal();
  }
});

onAuthStateChanged(auth, async user => {
  if (unsubscribeClients) unsubscribeClients();
  if (unsubscribeUsers) unsubscribeUsers();
  if (unsubscribeProfile) unsubscribeProfile();

  if (!user) {
    location.replace("index.html");
    return;
  }

  currentUser = user;

  try {
    const profileRef = doc(db, "usuarios", user.uid);
    const profile = await getDoc(profileRef);

    if (
      !profile.exists() ||
      profile.data().rol !== "admin" ||
      profile.data().estado !== "activo"
    ) {
      location.replace("index.html");
      return;
    }

    $("adminName").textContent =
      profile.data().nombre || "ADMINISTRADOR";

    unsubscribeProfile = onSnapshot(profileRef, snapshot => {
      if (
        !snapshot.exists() ||
        snapshot.data().rol !== "admin" ||
        snapshot.data().estado !== "activo"
      ) {
        $("app").hidden = true;
        location.replace("index.html");
      }
    });

    unsubscribeUsers = onSnapshot(
      collection(db, "usuarios"),
      snapshot => {
        employees = snapshot.docs.map(item => ({
          ...item.data(),
          uid: item.id
        }));

        if (!$("modal").hidden) {
          renderEmployeeOptions();
        }

        render();
      },
      error => toast(`Error al cargar cobradores: ${error.message}`)
    );

    unsubscribeClients = onSnapshot(
      collection(db, "clientes"),
      snapshot => {
        clients = snapshot.docs.map(item => ({
          ...item.data(),
          id: item.id
        }));

        $("loading").hidden = true;
        $("app").hidden = false;
        render();
      },
      error => {
        $("loading").querySelector("p").textContent =
          "ERROR AL CONSULTAR CLIENTES";

        toast(`No se pudieron cargar los clientes: ${error.message}`);
      }
    );
  } catch (error) {
    $("loading").querySelector("p").textContent =
      "ERROR AL VERIFICAR ACCESO";
    toast(error.message);
  }
});
