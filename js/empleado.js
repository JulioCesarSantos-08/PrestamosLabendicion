
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  onSnapshot,
  getDoc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let clients = [];
let loans = [];
let unsubscribers = [];
let sessionVersion = 0;
let clientsLoaded = false;
let loansLoaded = false;
let selectedTab = "home";

const currency = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

function money(cents) {
  return currency.format((Number(cents) || 0) / 100);
}

function make(tag, className = "", content) {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function firstName(name) {
  return String(name || "COBRADOR").trim().split(/\s+/)[0];
}

function normalize(value) {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .toLocaleUpperCase("es-MX");
}

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(item => item.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;

  const d = new Date(value + "T12:00:00Z");
  return Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
}

function dateToUTC(value) {
  if (!validDate(value)) return null;
  return Date.parse(value + "T12:00:00Z");
}

function addDays(value, count) {
  const time = dateToUTC(value);
  if (time === null || !Number.isInteger(count)) return null;

  const date = new Date(time);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function dateDisplay(value) {
  if (!validDate(value)) return "Sin fecha";

  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function dateWords(value) {
  if (!validDate(value)) return "Sin fecha";

  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date(value + "T12:00:00Z"));
}

function todayLabel() {
  return dateWords(today());
}

function daysBetween(first, second) {
  const a = dateToUTC(first);
  const b = dateToUTC(second);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

function clientById(id) {
  return clients.find(client => client.id === id);
}

function pointFromValue(value) {
  const match = String(value || "").trim().match(
    /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/
  );

  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) return null;

  return `${latitude},${longitude}`;
}

function mapsURL(value) {
  const point = pointFromValue(value);

  if (point) {
    return "https://www.google.com/maps/dir/?api=1" +
      "&destination=" + encodeURIComponent(point) +
      "&travelmode=driving&dir_action=navigate";
  }

  try {
    const url = new URL(String(value || ""));

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    ) return null;

    const allowed =
      (
        ["google.com", "www.google.com", "maps.google.com"].includes(url.hostname) &&
        url.pathname.startsWith("/maps")
      ) ||
      (
        url.hostname === "maps.app.goo.gl" &&
        url.pathname.length > 1
      ) ||
      (
        url.hostname === "goo.gl" &&
        url.pathname.startsWith("/maps/")
      );

    return allowed ? url.href : null;
  } catch {
    return null;
  }
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}

function action(text, callback, style = "") {
  const button = make("button", "card-button " + style, text);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

function link(text, href, style = "") {
  const anchor = make("a", "card-button " + style, text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

function appendContactActions(container, client) {
  if (!client) return;

  const phone = String(client.telefono || "");

  if (/^\d{10}$/.test(phone)) {
    container.append(link("WhatsApp", `https://wa.me/52${phone}`));
    container.append(link("Llamar", `tel:+52${phone}`));
  }

  const map = mapsURL(client.ubicacionMaps);

  if (map) {
    container.append(link("Cómo llegar", map, "gold"));
  }
}

function nextScheduledVisit(loan, reference = today()) {
  if (
    !validDate(loan.primeraFecha) ||
    !validDate(loan.fechaFin) ||
    !Number.isInteger(loan.intervaloDias) ||
    !Number.isInteger(loan.numeroPagos) ||
    loan.intervaloDias < 1 ||
    loan.numeroPagos < 1
  ) return null;

  const start = loan.primeraFecha;
  const interval = loan.intervaloDias;

  if (reference > loan.fechaFin) return null;

  const passed = daysBetween(start, reference);

  if (passed === null) return null;

  const index = passed <= 0
    ? 0
    : Math.ceil(passed / interval);

  if (index >= loan.numeroPagos) return null;

  const date = addDays(start, index * interval);

  if (!date || date > loan.fechaFin) return null;

  return {
    loan,
    date,
    paymentNumber: index + 1,
    client: clientById(loan.clienteId)
  };
}

function makeVisitCard(visit) {
  const card = make("article", "visit-card");
  const avatar = make("div", "card-icon", "⌖");
  const body = make("div", "card-content");
  const client = visit.client;

  body.append(make("h3", "", visit.loan.clienteNombre || "CLIENTE"));
  body.append(make("p", "", client?.domicilio || "Domicilio no disponible"));
  body.append(make("p", "", `Préstamo: ${visit.loan.folio}`));

  body.append(make(
    "span",
    "card-tag gold",
    dateWords(visit.date)
  ));

  body.append(make(
    "span",
    "card-tag",
    `Pago programado ${visit.paymentNumber} de ${visit.loan.numeroPagos}`
  ));

  if (Number.isInteger(visit.loan.abonoCentavos)) {
    body.append(make(
      "p",
      "",
      `Abono habitual acordado: ${money(visit.loan.abonoCentavos)}`
    ));
  }

  const actions = make("div", "card-actions");

  actions.append(
    action("Ver préstamo", () => showLoanDetails(visit.loan), "primary")
  );

  const collectButton = action("Registrar abono", () => {}, "collect");
  collectButton.dataset.employeeCollect = visit.loan.id;


  actions.append(collectButton);
  appendContactActions(actions, client);

  body.append(actions);
  card.append(avatar, body);

  return card;
}

function renderVisits() {
  const currentDate = today();
  const lastDate = addDays(currentDate, 7);

  const todayList = $("todayList");
  const upcomingList = $("upcomingList");

  todayList.replaceChildren();
  upcomingList.replaceChildren();

  const todayVisits = [];
  const futureVisits = [];

  for (const loan of loans) {
    const firstVisit = nextScheduledVisit(loan, currentDate);

    if (!firstVisit) continue;

    const indexStart = firstVisit.paymentNumber - 1;

    for (
      let index = indexStart;
      index < loan.numeroPagos;
      index++
    ) {
      const visitDate = addDays(
        loan.primeraFecha,
        index * loan.intervaloDias
      );

      if (!visitDate) break;
      if (visitDate > lastDate) break;
      if (visitDate > loan.fechaFin) break;

      const visit = {
        loan,
        date: visitDate,
        paymentNumber: index + 1,
        client: clientById(loan.clienteId)
      };

      if (visitDate === currentDate) {
        todayVisits.push(visit);
      } else if (visitDate > currentDate) {
        futureVisits.push(visit);
      }
    }
  }

  const ordenar = (a, b) =>
    a.date.localeCompare(b.date) ||
    String(a.loan.clienteNombre || "").localeCompare(
      String(b.loan.clienteNombre || ""),
      "es"
    );

  todayVisits.sort(ordenar);
  futureVisits.sort(ordenar);

  $("todayVisits").textContent = todayVisits.length;
  $("upcomingVisits").textContent = futureVisits.length;

  if (todayVisits.length === 0) {
    todayList.append(make(
      "div",
      "empty",
      "No tienes visitas programadas para hoy."
    ));
  } else {
    for (const visit of todayVisits) {
      todayList.append(makeVisitCard(visit));
    }
  }

  if (futureVisits.length === 0) {
    upcomingList.append(make(
      "div",
      "empty",
      "No hay visitas programadas en los próximos siete días."
    ));
  } else {
    for (const visit of futureVisits) {
      upcomingList.append(makeVisitCard(visit));
    }
  }
}
function renderClients() {
  const container = $("clientsList");
  const search = normalize($("clientSearch").value);
  container.replaceChildren();

  const filtered = clients.filter(client =>
    normalize(`${client.nombre} ${client.telefono} ${client.domicilio}`)
      .includes(search)
  ).sort((a, b) =>
    (a.nombre || "").localeCompare(b.nombre || "", "es")
  );

  if (!filtered.length) {
    container.append(make("div", "empty", "No tienes clientes que coincidan con la búsqueda."));
    return;
  }

  for (const client of filtered) {
    const card = make("article", "customer-card");
    const avatar = make("div", "card-icon", (client.nombre || "C").charAt(0));
    const body = make("div", "card-content");

    body.append(make("h3", "", client.nombre || "SIN NOMBRE"));
    body.append(make("p", "", client.domicilio || "Sin domicilio"));
    body.append(make("p", "", `Teléfono: ${client.telefono || "No registrado"}`));

    if (mapsURL(client.ubicacionMaps)) {
      body.append(make("span", "card-tag gold", "Ubicación disponible"));
    }

    const actions = make("div", "card-actions");

    actions.append(
      action("Ver expediente", () => showClientDetails(client), "primary")
    );

    appendContactActions(actions, client);

    body.append(actions);
    card.append(avatar, body);
    container.append(card);
  }
}

function renderLoans() {
  const container = $("loansList");
  const search = normalize($("loanSearch").value);
  container.replaceChildren();

  const filtered = loans.filter(loan =>
    normalize(`${loan.clienteNombre} ${loan.folio}`).includes(search)
  ).sort((a, b) =>
    (b.creadoEn?.toMillis?.() || 0) -
    (a.creadoEn?.toMillis?.() || 0)
  );

  if (!filtered.length) {
    container.append(make("div", "empty", "No tienes préstamos asignados que coincidan con la búsqueda."));
    return;
  }

  for (const loan of filtered) {
    const card = make("article", "loan-card");
    const avatar = make("div", "card-icon", "$");
    const body = make("div", "card-content");

    body.append(make("h3", "", loan.clienteNombre || "SIN NOMBRE"));
    body.append(make("p", "", `Folio: ${loan.folio || loan.id}`));
    body.append(make("p", "", `Capital entregado: ${money(loan.capitalCentavos)}`));

    if (Number.isInteger(loan.abonoCentavos)) {
      body.append(make("p", "", `Abono habitual: ${money(loan.abonoCentavos)}`));
    }

    body.append(make(
      "span",
      "card-tag gold",
      `Finalización prevista: ${dateDisplay(loan.fechaFin)}`
    ));

    const actions = make("div", "card-actions");

    actions.append(
      action("Consultar préstamo", () => showLoanDetails(loan), "primary")
    );

    if (loan.tipoCalculo === "total_pactado_manual") {
      const collectButton = action("Registrar abono", () => {}, "collect");
      collectButton.dataset.employeeCollect = loan.id;
      actions.append(collectButton);
    }

    const client = clientById(loan.clienteId);
    appendContactActions(actions, client);

    body.append(actions);
    card.append(avatar, body);
    container.append(card);
  }
}

function detail(label, value) {
  const row = make("div", "detail-row");
  row.append(make("span", "", label));
  row.append(make("strong", "", value || "No registrado"));
  return row;
}

function showClientDetails(client) {
  $("detailsTitle").textContent = "Expediente del cliente";

  const body = $("detailsBody");
  body.replaceChildren();

  body.append(detail("Nombre completo", client.nombre));
  body.append(detail("Teléfono", client.telefono));
  body.append(detail("Domicilio", client.domicilio));
  body.append(detail("Referencias del domicilio", client.referencias));
  body.append(detail("Observaciones", client.observaciones));

  const actions = make("div", "card-actions");
  appendContactActions(actions, client);
  body.append(actions);

  $("detailsModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function showLoanDetails(loan) {
  $("detailsTitle").textContent = "Detalle del préstamo";

  const body = $("detailsBody");
  body.replaceChildren();

  body.append(detail("Folio", loan.folio));
  body.append(detail("Cliente", loan.clienteNombre));
  body.append(detail("Capital original", money(loan.capitalCentavos)));

  if (Number.isInteger(loan.totalPactadoCentavos)) {
    body.append(detail("Total pactado original", money(loan.totalPactadoCentavos)));
  }

  if (Number.isInteger(loan.tasaPuntosBase)) {
    body.append(detail("Tasa pactada", `${(loan.tasaPuntosBase / 100).toFixed(2)}%`));
  }

  if (Number.isInteger(loan.abonoCentavos)) {
    body.append(detail("Abono habitual", money(loan.abonoCentavos)));
  }

  if (Number.isInteger(loan.intervaloDias)) {
    body.append(detail("Periodicidad", `Cada ${loan.intervaloDias} días`));
  }

  body.append(detail("Entrega", dateDisplay(loan.fechaEntrega)));
  body.append(detail("Finalización prevista", dateDisplay(loan.fechaFin)));
  body.append(detail("Observaciones originales", loan.observaciones));

  body.append(make(
    "div",
    "info-box",
    "Este detalle muestra condiciones originales y fechas programadas, no un saldo actual ni confirmación de que el cliente haya pagado."
  ));

  const actions = make("div", "card-actions");
  appendContactActions(actions, clientById(loan.clienteId));
  body.append(actions);

  $("detailsModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDetails() {
  $("detailsModal").hidden = true;
  document.body.style.overflow = "";
}

function render() {
  if (!clientsLoaded || !loansLoaded) return;

  $("totalClients").textContent = clients.length;
  $("totalLoans").textContent = loans.length;

  renderVisits();
  renderClients();
  renderLoans();

  $("loading").hidden = true;
  $("app").hidden = false;
}

function changeTab(tab) {
  selectedTab = tab;

  for (const item of ["home", "clients", "loans", "account"]) {
    $(`${item}Section`).hidden = item !== tab;
  }

  document.querySelectorAll(".tab").forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);

    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  window.scrollTo({ top: 0, behavior: "instant" });
}

function cleanup() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  clientsLoaded = false;
  loansLoaded = false;
}

function denyAccess() {
  $("app").hidden = true;
  location.replace("index.html");
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    changeTab(button.dataset.tab);
  });
});

$("clientSearch").addEventListener("input", renderClients);
$("loanSearch").addEventListener("input", renderLoans);
$("closeDetails").addEventListener("click", closeDetails);
$("detailsDone").addEventListener("click", closeDetails);

$("detailsModal").addEventListener("click", event => {
  if (event.target === $("detailsModal")) closeDetails();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("detailsModal").hidden) {
    closeDetails();
  }
});

$("logout").addEventListener("click", async () => {
  await signOut(auth);
  denyAccess();
});

$("todayLabel").textContent = todayLabel();

onAuthStateChanged(auth, async user => {
  cleanup();
  const localVersion = ++sessionVersion;

  if (!user) {
    denyAccess();
    return;
  }

  try {
    const profileRef = doc(db, "usuarios", user.uid);
    const profileSnapshot = await getDoc(profileRef);

    if (localVersion !== sessionVersion) return;

    if (
      !profileSnapshot.exists() ||
      profileSnapshot.data().estado !== "activo" ||
      profileSnapshot.data().rol !== "empleado"
    ) {
      denyAccess();
      return;
    }

    currentUser = user;
    currentProfile = profileSnapshot.data();

    $("firstName").textContent = firstName(currentProfile.nombre);
    $("accountName").textContent = currentProfile.nombre || "EMPLEADO";
    $("accountEmail").textContent =
      currentProfile.correo || user.email || "Sin correo registrado";
    $("accountAvatar").textContent =
      (currentProfile.nombre || "E").charAt(0);

    unsubscribers.push(onSnapshot(profileRef, snapshot => {
      if (
        !snapshot.exists() ||
        snapshot.data().estado !== "activo" ||
        snapshot.data().rol !== "empleado"
      ) {
        denyAccess();
      }
    }));

    const clientsQuery = query(
      collection(db, "clientes"),
      where("empleadoId", "==", user.uid)
    );

    const loansQuery = query(
      collection(db, "prestamos"),
      where("empleadoId", "==", user.uid)
    );

    unsubscribers.push(onSnapshot(
      clientsQuery,
      snapshot => {
        if (localVersion !== sessionVersion) return;

        clients = snapshot.docs.map(item => ({
          ...item.data(),
          id: item.id
        }));

        clientsLoaded = true;
        render();
      },
      error => {
        $("loading").querySelector("p").textContent =
          "NO SE PUDIERON CONSULTAR TUS CLIENTES";
        console.error("Consulta de clientes:", error.code, error.message);
        toast("No tienes permisos para consultar los clientes asignados.");
      }
    ));

    unsubscribers.push(onSnapshot(
      loansQuery,
      snapshot => {
        if (localVersion !== sessionVersion) return;

        loans = snapshot.docs.map(item => ({
          ...item.data(),
          id: item.id
        }));

        loansLoaded = true;
        render();
      },
      error => {
        $("loading").querySelector("p").textContent =
          "NO SE PUDIERON CONSULTAR TUS PRÉSTAMOS";
        console.error("Consulta de préstamos:", error.code, error.message);
        toast("No tienes permisos para consultar los préstamos asignados.");
      }
    ));
  } catch (error) {
    $("loading").querySelector("p").textContent =
      "ERROR AL VERIFICAR LA CUENTA";
    console.error(error);
  }
});



