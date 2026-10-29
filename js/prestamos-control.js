
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  addDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const state = {
  user: null,
  profile: null,
  loans: new Map(),
  events: new Map(),
  employees: [],
  authorized: false,
  busy: false,
  unsubscribers: [],
  observer: null,
  scheduled: false
};

function el(tag, className = "", content) {
  const node = document.createElement(tag);
  node.className = className;

  if (content !== undefined) {
    node.textContent = String(content);
  }

  return node;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");
}

function toast(message) {
  const element = document.getElementById("toast");

  if (!element) return;

  element.textContent = message;
  element.classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 4000);
}

function createDialog() {
  const overlay = el("div", "loan-management-overlay");
  overlay.id = "loanManagementOverlay";
  overlay.hidden = true;

  overlay.innerHTML = `
    <section class="loan-management-dialog" role="dialog" aria-modal="true" aria-labelledby="loanManagementTitle">
      <header class="loan-management-header">
        <div>
          <small>PRÉSTAMOS LA BENDICIÓN</small>
          <h2 id="loanManagementTitle">Administrar préstamo</h2>
        </div>
        <button id="loanManagementClose" class="loan-management-close" type="button" aria-label="Cerrar">×</button>
      </header>
      <div class="loan-management-body" id="loanManagementBody"></div>
      <div class="loan-management-footer" id="loanManagementFooter"></div>
    </section>
  `;

  document.body.append(overlay);

  overlay.addEventListener("click", event => {
    if (event.target === overlay) closeDialog();
  });

  document.getElementById("loanManagementClose")
    .addEventListener("click", closeDialog);

  document.addEventListener("keydown", event => {
    if (
      event.key === "Escape" &&
      !overlay.hidden &&
      !state.busy
    ) {
      event.stopImmediatePropagation();
      closeDialog();
    }
  }, true);
}

function closeDialog() {
  if (state.busy) return;

  document.getElementById("loanManagementOverlay").hidden = true;
  document.getElementById("loanManagementBody").replaceChildren();
  document.getElementById("loanManagementFooter").replaceChildren();
  document.body.style.overflow = "";
}

function openDialog(title) {
  document.getElementById("loanManagementTitle").textContent = title;
  document.getElementById("loanManagementBody").replaceChildren();
  document.getElementById("loanManagementFooter").replaceChildren();
  document.getElementById("loanManagementOverlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function button(text, variant = "") {
  const element = el("button", variant, text);
  element.type = "button";
  return element;
}

function eventTime(event) {
  return event.creadoEn?.toMillis?.() || 0;
}

function eventList(id) {
  return [...(state.events.get(id) || [])]
    .sort((a, b) => {
      const difference = eventTime(a) - eventTime(b);
      return difference || a.id.localeCompare(b.id);
    });
}

function getCurrentState(loan) {
  const events = eventList(loan.id);
  const last = events.at(-1);

  return {
    estado: last?.estado || "activo",
    empleadoId: last?.empleadoId ?? loan.empleadoId ?? "",
    observaciones: last?.observaciones ?? loan.observaciones ?? "",
    last,
    events
  };
}

function findLoanByFolio(folio) {
  return [...state.loans.values()].find(loan => loan.folio === folio);
}

function employeeName(id) {
  if (!id) return "Sin cobrador asignado";

  return state.employees.find(user => user.uid === id)?.nombre ||
    "Cobrador no disponible";
}

function renderLoanControls() {
  if (!state.authorized) return;

  const cards = document.querySelectorAll(".loan-card");

  for (const card of cards) {
    if (card.querySelector(".loan-control")) continue;

    const folio = card.querySelector(".loan-folio")?.textContent?.trim();
    const loan = findLoanByFolio(folio);

    if (!loan) continue;

    const current = getCurrentState(loan);
    const wrapper = el("div", "loan-control");
    const status = el("div", "loan-control-state");
    const badge = el(
      "span",
      "loan-state-badge " + current.estado,
      current.estado.toUpperCase()
    );

    status.append(badge);

    if (current.events.length) {
      status.append(el(
        "span",
        "loan-meta",
        `${current.events.length} movimientos administrativos`
      ));
    }

    const actions = el("div", "loan-control-actions");

    function addAction(text, variant, handler, disabled = false) {
      const control = el(
        "button",
        "loan-control-button " + variant,
        text
      );

      control.type = "button";
      control.disabled = disabled;
      control.addEventListener("click", handler);
      actions.append(control);
    }

    addAction(
      "Editar datos",
      "",
      () => editLoan(loan),
      current.estado === "cancelado"
    );

    if (current.estado === "activo") {
      addAction("Pausar", "gold", () => changeStatus(loan, "pausado"));
    }

    if (current.estado === "pausado") {
      addAction("Reanudar", "gold", () => changeStatus(loan, "activo"));
    }

    addAction(
      "Cancelar",
      "danger",
      () => changeStatus(loan, "cancelado"),
      current.estado === "cancelado"
    );

    addAction("Historial", "", () => showHistory(loan));

    wrapper.append(status, actions);
    card.append(wrapper);
  }
}

function scheduleRender() {
  if (state.scheduled) return;

  state.scheduled = true;

  queueMicrotask(() => {
    state.scheduled = false;
    renderLoanControls();
  });
}

function field(label, control) {
  const wrapper = el("div", "loan-management-field");
  const labelElement = document.createElement("label");
  labelElement.textContent = label;

  if (control.id) {
    labelElement.htmlFor = control.id;
  }

  wrapper.append(labelElement, control);
  return wrapper;
}

function footerButtons(onSave, title) {
  const footer = document.getElementById("loanManagementFooter");
  footer.replaceChildren();

  const cancel = button("Regresar");
  const save = button(title, "primary");

  cancel.addEventListener("click", closeDialog);
  save.addEventListener("click", onSave);

  footer.append(cancel, save);
  return save;
}

async function recordEvent(loan, type, estado, empleadoId, observaciones, motivo) {
  if (!state.user || !state.authorized || state.busy) return;

  const current = getCurrentState(loan);

  if (current.estado === "cancelado") {
    toast("Este préstamo está cancelado y no admite cambios.");
    return;
  }

  if (type === "pausar" && current.estado !== "activo") return;
  if (type === "reanudar" && current.estado !== "pausado") return;
  if (type === "editar" && estado !== current.estado) return;

  if (
    empleadoId &&
    !state.employees.some(user =>
      user.uid === empleadoId &&
      user.estado === "activo" &&
      user.rol === "empleado"
    )
  ) {
    toast("El cobrador seleccionado no está activo.");
    return;
  }

  if (motivo.length < 8 || motivo.length > 300) {
    toast("Escribe un motivo de entre 8 y 300 caracteres.");
    return;
  }

  if (observaciones.length > 500) {
    toast("Las observaciones no pueden superar 500 caracteres.");
    return;
  }

  state.busy = true;

  try {
    const eventPayload = {
      prestamoId: loan.id,
      folio: loan.folio,
      tipo: type,
      estado,
      empleadoId,
      observaciones,
      motivo,
      creadoPor: state.user.uid,
      creadorNombre: state.profile.nombre,
      creadoEn: serverTimestamp()
    };

    const changingEmployee =
      type === "editar" && empleadoId !== (loan.empleadoId || "");

    if (changingEmployee) {
      const relatedLoans = [...state.loans.values()].filter(
        item => item.clienteId === loan.clienteId
      );

      if (relatedLoans.length !== 1) {
        throw new Error(
          "Este cliente tiene varios préstamos y requiere revisión antes de reasignarlo."
        );
      }
    }

    const eventRef = doc(collection(db, "prestamoEventos"));
    const controlRef = doc(db, "prestamoControl", loan.id);
    const batch = writeBatch(db);

    batch.set(eventRef, eventPayload);

    batch.set(controlRef, {
      prestamoId: loan.id,
      estado,
      empleadoId,
      ultimoEventoId: eventRef.id,
      actualizadoPor: state.user.uid,
      actualizadoEn: serverTimestamp()
    });

    if (changingEmployee) {
      batch.update(doc(db, "prestamos", loan.id), {
        empleadoId,
        ultimoEventoAsignacion: eventRef.id,
        actualizadoEn: serverTimestamp()
      });

      batch.update(doc(db, "clientes", loan.clienteId), {
        empleadoId,
        actualizadoPor: state.user.uid,
        actualizadoEn: serverTimestamp()
      });
    }

    await batch.commit();

    state.busy = false;
    closeDialog();
    toast("Movimiento registrado en el historial.");
  } catch (error) {
    state.busy = false;
    toast("No se pudo registrar el cambio: " + error.message);
  }
}

function editLoan(loan) {
  const current = getCurrentState(loan);

  if (current.estado === "cancelado") return;

  openDialog("Editar datos administrativos");

  const body = document.getElementById("loanManagementBody");

  body.append(el(
    "div",
    "loan-management-warning",
    "Puedes cambiar el cobrador y las observaciones. El capital, la tasa, el total pactado y las fechas originales no se modificarán."
  ));

  const select = document.createElement("select");
  select.id = "managementEmployee";

  select.add(new Option("Sin cobrador asignado", ""));

  for (const employee of state.employees.filter(user =>
    user.estado === "activo" && user.rol === "empleado"
  )) {
    select.add(new Option(employee.nombre, employee.uid));
  }

  if (
    current.empleadoId &&
    ![...select.options].some(option => option.value === current.empleadoId)
  ) {
    select.add(new Option(
      "Cobrador anterior no disponible",
      current.empleadoId
    ));
  }

  select.value = current.empleadoId;

  const notes = document.createElement("textarea");
  notes.id = "managementNotes";
  notes.maxLength = 500;
  notes.value = current.observaciones;

  const reason = document.createElement("textarea");
  reason.id = "managementReason";
  reason.maxLength = 300;
  reason.required = true;
  reason.placeholder = "Explica por qué se realiza esta modificación";

  body.append(field("Cobrador responsable", select));
  body.append(field("Observaciones administrativas", notes));
  body.append(field("Motivo del cambio", reason));

  footerButtons(async () => {
    const selected = select.value;
    const observations = normalize(notes.value);
    const motivo = normalize(reason.value);

    if (
      selected === current.empleadoId &&
      observations === current.observaciones
    ) {
      toast("No se detectaron cambios.");
      return;
    }

    await recordEvent(
      loan,
      "editar",
      current.estado,
      selected,
      observations,
      motivo
    );
  }, "Guardar cambios");
}

function changeStatus(loan, estado) {
  const current = getCurrentState(loan);

  if (current.estado === "cancelado") return;

  const type = estado === "pausado"
    ? "pausar"
    : estado === "cancelado"
      ? "cancelar"
      : "reanudar";

  const labels = {
    pausar: "Pausar préstamo",
    reanudar: "Reanudar préstamo",
    cancelar: "Cancelar préstamo"
  };

  openDialog(labels[type]);

  const body = document.getElementById("loanManagementBody");

  const explanations = {
    pausar: "El préstamo quedará marcado como pausado. Esto no cancela su deuda ni modifica automáticamente las fechas pactadas.",
    reanudar: "El préstamo volverá al estado activo. Las fechas originales permanecerán registradas.",
    cancelar: "La cancelación será administrativa y quedará en el historial. No implica automáticamente que la deuda fue pagada o perdonada. Esta acción no podrá revertirse desde este panel."
  };

  body.append(el(
    "div",
    "loan-management-warning",
    explanations[type]
  ));

  const reason = document.createElement("textarea");
  reason.id = "managementReason";
  reason.maxLength = 300;
  reason.placeholder = "Escribe el motivo obligatorio";
  reason.required = true;

  body.append(field("Motivo de la operación", reason));

  footerButtons(async () => {
    const motivo = normalize(reason.value);

    if (motivo.length < 8) {
      toast("Especifica un motivo de al menos 8 caracteres.");
      return;
    }

    if (type === "cancelar") {
      const confirmed = confirm(
        "¿Confirmas la cancelación administrativa de este préstamo? El registro original y el comprobante permanecerán guardados."
      );

      if (!confirmed) return;
    }

    await recordEvent(
      loan,
      type,
      estado,
      current.empleadoId,
      current.observaciones,
      motivo
    );
  }, labels[type]);
}

function showHistory(loan) {
  openDialog("Historial administrativo");

  const body = document.getElementById("loanManagementBody");
  const events = eventList(loan.id).reverse();

  body.append(el(
    "div",
    "loan-management-warning",
    `Préstamo ${loan.folio}. Los movimientos se conservan sin modificar el registro original.`
  ));

  if (!events.length) {
    body.append(el(
      "p",
      "loan-management-help",
      "Todavía no hay modificaciones administrativas registradas."
    ));
  }

  for (const event of events) {
    const item = el("article", "loan-history-item");
    const labels = {
      editar: "Datos administrativos modificados",
      pausar: "Préstamo pausado",
      reanudar: "Préstamo reanudado",
      cancelar: "Préstamo cancelado"
    };

    const date = event.creadoEn?.toDate?.();

    item.append(el(
      "strong",
      "",
      labels[event.tipo] || event.tipo
    ));

    item.append(el(
      "small",
      "",
      `${event.creadorNombre || "ADMINISTRADOR"} · ${
        date ? date.toLocaleString("es-MX") : "Fecha pendiente"
      }`
    ));

    item.append(el("p", "", `Motivo: ${event.motivo}`));
    item.append(el("p", "", `Estado resultante: ${event.estado}`));
    item.append(el(
      "p",
      "",
      `Cobrador: ${employeeName(event.empleadoId)}`
    ));

    if (event.observaciones) {
      item.append(el("p", "", `Observaciones: ${event.observaciones}`));
    }

    body.append(item);
  }

  footerButtons(closeDialog, "Cerrar historial");
}

function cleanup() {
  for (const unsubscribe of state.unsubscribers) {
    unsubscribe();
  }

  state.unsubscribers = [];
}

onAuthStateChanged(auth, async user => {
  cleanup();
  state.authorized = false;
  state.user = null;

  if (!user) return;

  try {
    const profile = await getDoc(doc(db, "usuarios", user.uid));

    if (
      !profile.exists() ||
      profile.data().rol !== "admin" ||
      profile.data().estado !== "activo"
    ) return;

    state.user = user;
    state.profile = profile.data();
    state.authorized = true;

    state.unsubscribers.push(
      onSnapshot(doc(db, "usuarios", user.uid), snapshot => {
        if (
          !snapshot.exists() ||
          snapshot.data().rol !== "admin" ||
          snapshot.data().estado !== "activo"
        ) {
          state.authorized = false;
          cleanup();
          location.replace("index.html");
        }
      })
    );

    state.unsubscribers.push(
      onSnapshot(collection(db, "prestamos"), snapshot => {
        state.loans = new Map(
          snapshot.docs.map(item => [
            item.id,
            { ...item.data(), id: item.id }
          ])
        );

        scheduleRender();
      })
    );

    state.unsubscribers.push(
      onSnapshot(collection(db, "usuarios"), snapshot => {
        state.employees = snapshot.docs.map(item => ({
          ...item.data(),
          uid: item.id
        }));

        scheduleRender();
      })
    );

    state.unsubscribers.push(
      onSnapshot(collection(db, "prestamoEventos"), snapshot => {
        const events = new Map();

        for (const item of snapshot.docs) {
          const event = { ...item.data(), id: item.id };

          if (!events.has(event.prestamoId)) {
            events.set(event.prestamoId, []);
          }

          events.get(event.prestamoId).push(event);
        }

        state.events = events;

        document.querySelectorAll(".loan-control").forEach(node => {
          node.remove();
        });

        scheduleRender();
      })
    );

    if (!state.observer) {
      state.observer = new MutationObserver(scheduleRender);

      const list = document.getElementById("loanList");

      if (list) {
        state.observer.observe(list, {
          childList: true,
          subtree: true
        });
      }
    }

    createDialog();
  } catch (error) {
    console.error("Error al preparar controles:", error);
  }
});


