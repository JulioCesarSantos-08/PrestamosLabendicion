
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
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let administratorName = "";
let clients = [];
let employees = [];
let loans = [];
let receipts = new Map();
let selectedReceipt = null;
let saving = false;
let sessionVersion = 0;
let unsubscribers = [];

const currency = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

function money(cents) {
  return currency.format((Number(cents) || 0) / 100);
}

function text(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeName(value) {
  return text(value).toLocaleUpperCase("es-MX");
}

function make(tag, className = "", content) {
  const element = document.createElement(tag);
  element.className = className;
  if (content !== undefined) element.textContent = String(content);
  return element;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(part => part.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function addDays(value, days) {
  if (!isDate(value)) return null;

  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function dateDisplay(value) {
  if (!isDate(value)) return "Sin fecha";

  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function moneyInput(value) {
  const number = Number(value);

  if (
    value === "" ||
    !Number.isFinite(number) ||
    number <= 0 ||
    number > 999999999.99 ||
    Math.abs(number * 100 - Math.round(number * 100)) > 0.00001
  ) return null;

  return Math.round(number * 100);
}

function percentageInput(value) {
  const number = Number(value);

  if (
    value === "" ||
    !Number.isFinite(number) ||
    number < 0 ||
    number > 100 ||
    Math.abs(number * 100 - Math.round(number * 100)) > 0.00001
  ) return null;

  return Math.round(number * 100);
}

function calculateSchedule() {
  const capital = moneyInput($("capital").value);
  const total = moneyInput($("totalPactado").value);
  const installment = moneyInput($("abono").value);
  const interval = Number($("intervaloDias").value);
  const start = $("fechaEntrega").value;

  if (
    capital === null ||
    total === null ||
    installment === null ||
    total < capital ||
    installment > total ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 365 ||
    !isDate(start)
  ) return null;

  const numberOfPayments = Math.ceil(total / installment);

  if (
    numberOfPayments < 1 ||
    numberOfPayments > 3650 ||
    numberOfPayments * interval > 36500
  ) return null;

  return {
    capitalCentavos: capital,
    totalPactadoCentavos: total,
    abonoCentavos: installment,
    intervaloDias: interval,
    numeroPagos: numberOfPayments,
    ultimoAbonoCentavos: total - installment * (numberOfPayments - 1),
    primeraFecha: addDays(start, interval),
    fechaFin: addDays(start, interval * numberOfPayments)
  };
}

function updateSchedule() {
  const schedule = calculateSchedule();
  const box = $("schedulePreview");

  box.replaceChildren();

  if (!schedule) {
    $("fechaFin").value = "";
    box.textContent = "Completa capital, total pactado, abono, intervalo y fecha de entrega. El total debe ser igual o mayor que el capital.";
    return;
  }

  $("fechaFin").value = schedule.fechaFin;

  box.append(make("strong", "", `${schedule.numeroPagos} pagos programados`));
  box.append(make(
    "p",
    "",
    `Primer abono: ${dateDisplay(schedule.primeraFecha)} · Cada ${schedule.intervaloDias} días`
  ));
  box.append(make(
    "p",
    "",
    `Finalización prevista: ${dateDisplay(schedule.fechaFin)}`
  ));
  box.append(make(
    "p",
    "",
    `Abono habitual: ${money(schedule.abonoCentavos)} · Último abono: ${money(schedule.ultimoAbonoCentavos)}`
  ));
  box.append(make(
    "p",
    "",
    `Total acordado: ${money(schedule.totalPactadoCentavos)}`
  ));
}

function clientById(id) {
  return clients.find(client => client.id === id);
}

function employeeById(id) {
  return employees.find(employee => employee.uid === id);
}

function renderClients() {
  const selected = $("clienteId").value;

  $("clienteId").replaceChildren(new Option("Selecciona un cliente", ""));

  for (const client of [...clients].sort((a, b) =>
    (a.nombre || "").localeCompare(b.nombre || "", "es")
  )) {
    $("clienteId").add(
      new Option(`${client.nombre} · ${client.telefono}`, client.id)
    );
  }

  $("clienteId").value = selected;
}

function renderEmployees(selected = "") {
  const select = $("empleadoId");
  select.replaceChildren(new Option("Sin asignar", ""));

  for (const employee of employees.filter(user =>
    user.estado === "activo" &&
    user.rol === "empleado"
  )) {
    select.add(new Option(employee.nombre, employee.uid));
  }

  select.value = selected;
}

function openLoanModal() {
  $("loanForm").reset();
  $("formMessage").textContent = "";
  $("fechaEntrega").value = today();
  renderClients();
  renderEmployees();
  updateSchedule();
  $("loanModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeLoanModal() {
  if (saving) return;
  $("loanModal").hidden = true;
  document.body.style.overflow = "";
}

function isPast(loan) {
  return isDate(loan.fechaFin) && loan.fechaFin < today();
}

function renderLoans() {
  const total = loans.reduce(
    (sum, loan) => sum + (Number(loan.capitalCentavos) || 0),
    0
  );

  $("capitalTotal").textContent = money(total);
  $("loanCount").textContent = loans.length;
  $("lateCount").textContent = loans.filter(isPast).length;
  $("borrowerCount").textContent =
    new Set(loans.map(loan => loan.clienteId)).size;

  const search = $("search").value.trim().toLocaleUpperCase("es-MX");
  const filter = $("filter").value;

  const filtered = loans.filter(loan => {
    const words = [
      loan.folio,
      loan.clienteNombre
    ].join(" ").toLocaleUpperCase("es-MX");

    if (!words.includes(search)) return false;
    if (filter === "vigente" && isPast(loan)) return false;
    if (filter === "revision" && !isPast(loan)) return false;
    if (filter === "conRecibo" && !receipts.has(loan.id)) return false;
    if (filter === "sinRecibo" && receipts.has(loan.id)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    return (b.creadoEn?.toMillis?.() || 0) -
      (a.creadoEn?.toMillis?.() || 0);
  });

  $("resultCount").textContent = `${filtered.length} préstamos encontrados`;

  const container = $("loanList");
  container.replaceChildren();

  if (!filtered.length) {
    container.append(make("div", "empty", "No se encontraron préstamos."));
    return;
  }

  for (const loan of filtered) {
    const card = make("article", "loan-card");
    const main = make("div", "loan-main");
    const side = make("div", "loan-side");
    const tags = make("div", "loan-tags");

    main.append(make("div", "loan-folio", loan.folio || loan.id));
    main.append(make("h4", "", loan.clienteNombre || "SIN NOMBRE"));

    main.append(make(
      "div",
      "loan-meta",
      `Entrega: ${dateDisplay(loan.fechaEntrega)} · Finalización prevista: ${dateDisplay(loan.fechaFin)}`
    ));

    main.append(make(
      "div",
      "loan-meta",
      `Tasa registrada: ${(Number(loan.tasaPuntosBase) / 100).toFixed(2)}%`
    ));

    const employee = employeeById(loan.empleadoId);

    main.append(make(
      "div",
      "loan-meta",
      `Cobrador: ${employee?.nombre || "Sin cobrador asignado"}`
    ));

    if (Number.isInteger(loan.intervaloDias)) {
      main.append(make(
        "div",
        "loan-extra",
        `${loan.numeroPagos} pagos cada ${loan.intervaloDias} días · Abono habitual ${money(loan.abonoCentavos)}`
      ));
    }

    tags.append(make(
      "span",
      "loan-tag" + (isPast(loan) ? " warning" : ""),
      isPast(loan) ? "Plazo concluido" : "Plazo vigente"
    ));

    const receipt = receipts.get(loan.id);

    tags.append(make(
      "span",
      "loan-tag",
      receipt ? "Comprobante guardado" : "Sin comprobante de entrega"
    ));

    main.append(tags);

    side.append(make("span", "", "Capital entregado"));
    side.append(make("strong", "", money(loan.capitalCentavos)));

    if (Number.isInteger(loan.totalPactadoCentavos)) {
      side.append(make("small", "", `Total pactado: ${money(loan.totalPactadoCentavos)}`));
    }

    side.append(make("div", "loan-extra", "No representa el saldo pendiente"));

    if (receipt) {
      const actions = make("div", "loan-actions");
      const button = make("button", "receipt-button", "Ver recibo");
      button.type = "button";
      button.addEventListener("click", () => showReceipt(receipt));
      actions.append(button);
      side.append(actions);
    }

    card.append(main, side);
    container.append(card);
  }
}

async function registerLoan(event) {
  event.preventDefault();

  if (saving || !currentUser) return;

  const client = clientById($("clienteId").value);
  const schedule = calculateSchedule();
  const rate = percentageInput($("tasa").value);
  const employeeId = $("empleadoId").value;

  const error = message => {
    $("formMessage").textContent = message;
  };

  if (!client) return error("Selecciona un cliente.");
  if (!schedule) return error("El calendario de pagos no es válido.");
  if (rate === null) return error("Introduce una tasa válida.");

  if (
    employeeId &&
    !employees.some(employee =>
      employee.uid === employeeId &&
      employee.rol === "empleado" &&
      employee.estado === "activo"
    )
  ) return error("El cobrador seleccionado no está activo.");

  if (!$("confirmDelivery").checked) {
    return error("Confirma la entrega del capital antes de registrar.");
  }

  saving = true;
  $("saveButton").disabled = true;
  $("saveButton").textContent = "Guardando operación...";
  $("formMessage").textContent = "";

  let committed = false;
  let receiptId = null;

  try {
    const loanRef = doc(collection(db, "prestamos"));
    const receiptRef = doc(db, "recibosPrestamo", loanRef.id);

    const folio = `PLB-${loanRef.id.slice(0, 10).toUpperCase()}`;

    const loan = {
      folio,
      clienteId: client.id,
      clienteNombre: normalizeName(client.nombre),
      capitalCentavos: schedule.capitalCentavos,
      tasaPuntosBase: rate,
      totalPactadoCentavos: schedule.totalPactadoCentavos,
      abonoCentavos: schedule.abonoCentavos,
      intervaloDias: schedule.intervaloDias,
      numeroPagos: schedule.numeroPagos,
      primeraFecha: schedule.primeraFecha,
      ultimoAbonoCentavos: schedule.ultimoAbonoCentavos,
      fechaEntrega: $("fechaEntrega").value,
      fechaFin: schedule.fechaFin,
      empleadoId: employeeId,
      observaciones: text($("observaciones").value),
      tipoCalculo: "total_pactado_manual",
      entregaConfirmada: true,
      creadoPor: currentUser.uid,
      creadoEn: serverTimestamp()
    };

    const receipt = {
      folio,
      prestamoId: loanRef.id,
      clienteId: client.id,
      clienteNombre: normalizeName(client.nombre),
      capitalCentavos: schedule.capitalCentavos,
      tasaPuntosBase: rate,
      totalPactadoCentavos: schedule.totalPactadoCentavos,
      abonoCentavos: schedule.abonoCentavos,
      intervaloDias: schedule.intervaloDias,
      numeroPagos: schedule.numeroPagos,
      primeraFecha: schedule.primeraFecha,
      ultimoAbonoCentavos: schedule.ultimoAbonoCentavos,
      fechaEntrega: $("fechaEntrega").value,
      fechaFin: schedule.fechaFin,
      empleadoId: employeeId,
      observaciones: text($("observaciones").value),
      creadoPor: currentUser.uid,
      creadorNombre: administratorName,
      creadoEn: serverTimestamp(),
      tipo: "entrega_prestamo"
    };

    const batch = writeBatch(db);

    batch.set(loanRef, loan);
    batch.set(receiptRef, receipt);

    await batch.commit();

    committed = true;
    receiptId = receiptRef.id;
    saving = false;
    closeLoanModal();

    toast("Préstamo y comprobante registrados correctamente.");

    const saved = await getDoc(receiptRef);

    if (saved.exists()) {
      showReceipt({ ...saved.data(), id: saved.id });
    }
  } catch (err) {
    if (committed) {
      toast("El préstamo se guardó. Abre el recibo desde el historial.");
    } else {
      error(
        err.code === "permission-denied"
          ? "Firestore rechazó el registro. Revisa las reglas publicadas."
          : `No se pudo guardar: ${err.message}`
      );
    }
  } finally {
    saving = false;
    $("saveButton").disabled = false;
    $("saveButton").textContent = "Registrar y generar recibo";
  }
}

function receiptLine(label, value) {
  const row = make("div", "receipt-line");
  row.append(make("span", "", label), make("strong", "", value));
  return row;
}

function receiptDate(receipt) {
  if (!receipt.creadoEn?.toDate) return "Fecha de registro no disponible";

  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(receipt.creadoEn.toDate());
}

function showReceipt(receipt) {
  selectedReceipt = receipt;

  const paper = make("div", "receipt-paper");
  const brand = make("div", "receipt-brand");
  const image = document.createElement("img");

  image.src = "imagenes/logo.png";
  image.alt = "Préstamos La Bendición";

  brand.append(image);
  brand.append(make("h3", "", "PRÉSTAMOS LA BENDICIÓN"));
  brand.append(make("p", "", "COMPROBANTE DE ENTREGA DE CAPITAL"));

  const heading = make("div", "receipt-heading");
  heading.append(make("strong", "", "CONSTANCIA DE ENTREGA DE PRÉSTAMO"));
  heading.append(make("span", "", receipt.folio));
  heading.append(make("span", "", `Registro: ${receiptDate(receipt)}`));

  paper.append(brand, heading);
  paper.append(receiptLine("Cliente", receipt.clienteNombre));
  paper.append(receiptLine("Fecha de entrega declarada", dateDisplay(receipt.fechaEntrega)));
  paper.append(receiptLine("Tasa pactada registrada", `${(receipt.tasaPuntosBase / 100).toFixed(2)}%`));
  paper.append(receiptLine("Total acordado a devolver", money(receipt.totalPactadoCentavos)));
  paper.append(receiptLine("Abono habitual", money(receipt.abonoCentavos)));
  paper.append(receiptLine("Periodicidad", `Cada ${receipt.intervaloDias} días`));
  paper.append(receiptLine("Número de pagos", receipt.numeroPagos));
  paper.append(receiptLine("Último abono previsto", money(receipt.ultimoAbonoCentavos)));
  paper.append(receiptLine("Primer pago previsto", dateDisplay(receipt.primeraFecha)));
  paper.append(receiptLine("Finalización prevista", dateDisplay(receipt.fechaFin)));
  paper.append(receiptLine("Registró", receipt.creadorNombre || "ADMINISTRACIÓN"));

  const total = make("div", "receipt-total");
  total.append(make("span", "", "CAPITAL ENTREGADO"));
  total.append(make("strong", "", money(receipt.capitalCentavos)));
  paper.append(total);

  if (receipt.observaciones) {
    paper.append(receiptLine("Condiciones registradas", receipt.observaciones));
  }

  paper.append(make(
    "p",
    "receipt-note",
    "Este comprobante registra una entrega de capital declarada por el operador. No representa un abono ni acredita por sí solo la recepción o aceptación por parte del cliente."
  ));

  const signatures = make("div", "receipt-signatures");
  signatures.append(
    make("div", "", "Firma de recibido del cliente"),
    make("div", "", "Firma de quien entrega")
  );
  paper.append(signatures);

  paper.append(make("p", "receipt-note", "Cualquier duda o inconveniente, comunicarse al 954 148 9953."));
  $("receiptPreview").replaceChildren(paper);
  $("receiptMessage").textContent =
    "El comprobante está guardado en Firestore. Puedes volver a generarlo desde el historial.";
  $("receiptModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeReceipt() {
  $("receiptModal").hidden = true;
  selectedReceipt = null;
  document.body.style.overflow = "";
}

function pdfText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[^\x20-\xFF]/g, " ");
}

async function logoData() {
  try {
    const img = new Image();
    img.src = "imagenes/logo.png";
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 240;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 240, 240);

    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

async function createPDF(receipt) {
  if (!window.jspdf?.jsPDF) {
    throw new Error("No se pudo cargar el generador de PDF. Comprueba tu conexión.");
  }

  const pdf = new window.jspdf.jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });

  const navy = [6, 29, 61];
  const gold = [201, 163, 90];
  const muted = [91, 107, 127];

  pdf.setFillColor(...navy);
  pdf.rect(0, 0, 210, 47, "F");

  const logo = await logoData();

  if (logo) {
    pdf.addImage(logo, "PNG", 14, 8, 29, 29);
  }

  pdf.setTextColor(236, 207, 143);
  pdf.setFont("times", "bold");
  pdf.setFontSize(17);
  pdf.text("PRESTAMOS LA BENDICION", 49, 20);

  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text("CONSTANCIA DE ENTREGA DE CAPITAL", 49, 29);

  pdf.setTextColor(...navy);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  pdf.text("COMPROBANTE DE PRESTAMO", 15, 61);

  pdf.setFontSize(9);
  pdf.setTextColor(...muted);
  pdf.text(`Folio: ${pdfText(receipt.folio)}`, 15, 69);
  pdf.text(`Registrado: ${pdfText(receiptDate(receipt))}`, 15, 75);

  let y = 87;

  function line(label, value) {
    pdf.setDrawColor(232, 236, 242);
    pdf.line(15, y + 5, 195, y + 5);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(...muted);
    pdf.text(pdfText(label), 15, y);

    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(...navy);

    const wrapped = pdf.splitTextToSize(pdfText(value), 93);
    pdf.text(wrapped, 102, y);

    y += Math.max(10, wrapped.length * 5 + 3);
  }

  line("Cliente", receipt.clienteNombre);
  line("Fecha de entrega", dateDisplay(receipt.fechaEntrega));
  line("Tasa registrada", `${(receipt.tasaPuntosBase / 100).toFixed(2)}%`);
  line("Total pactado", money(receipt.totalPactadoCentavos));
  line("Abono habitual", money(receipt.abonoCentavos));
  line("Periodicidad", `Cada ${receipt.intervaloDias} dias`);
  line("Numero de pagos", receipt.numeroPagos);
  line("Ultimo pago previsto", money(receipt.ultimoAbonoCentavos));
  line("Primer vencimiento", dateDisplay(receipt.primeraFecha));
  line("Finalizacion prevista", dateDisplay(receipt.fechaFin));
  line("Registrado por", receipt.creadorNombre);

  pdf.setFillColor(...navy);
  pdf.roundedRect(15, y + 3, 180, 21, 3, 3, "F");

  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(10);
  pdf.text("CAPITAL ENTREGADO", 21, y + 16);

  pdf.setFont("helvetica", "bold");
  pdf.setTextColor(236, 207, 143);
  pdf.setFontSize(17);
  pdf.text(money(receipt.capitalCentavos), 188, y + 16, {
    align: "right"
  });

  y += 35;

  if (receipt.observaciones) {
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(...muted);
    pdf.setFontSize(8);

    const note = pdf.splitTextToSize(
      "Condiciones: " + pdfText(receipt.observaciones),
      180
    );

    pdf.text(note.slice(0, 6), 15, y);
    y += Math.min(6, note.length) * 4.5 + 6;
  }

  const signatureY = Math.max(y + 17, 242);

  pdf.setDrawColor(...muted);
  pdf.line(17, signatureY, 94, signatureY);
  pdf.line(116, signatureY, 193, signatureY);

  pdf.setTextColor(...muted);
  pdf.setFontSize(8);
  pdf.text("Firma de recibido del cliente", 55, signatureY + 6, { align: "center" });
  pdf.text("Firma de quien entrega", 155, signatureY + 6, { align: "center" });

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7.5);

  const legalText = pdf.splitTextToSize(
    "Registro de entrega declarado por el operador. Este documento no es un recibo de abono ni sustituye una constancia firmada por el cliente.",
    180
  );

  pdf.text(legalText, 105, 263, { align: "center" });
  pdf.setFontSize(8);
  pdf.text("Dudas o inconvenientes: 954 148 9953", 105, 276, { align: "center" });

  pdf.setDrawColor(...gold);
  pdf.line(15, 281, 195, 281);

  pdf.setTextColor(...muted);
  pdf.text(pdfText(receipt.folio), 105, 287, { align: "center" });

  return pdf;
}

function pdfFilename(receipt) {
  return `RECIBO-${receipt.folio}.pdf`;
}

async function downloadPDF() {
  if (!selectedReceipt) return;

  try {
    const pdf = await createPDF(selectedReceipt);
    pdf.save(pdfFilename(selectedReceipt));
    $("receiptMessage").textContent = "El PDF se descargó correctamente.";
  } catch (error) {
    $("receiptMessage").textContent = error.message;
  }
}

async function sharePDF() {
  if (!selectedReceipt) return;

  const receipt = selectedReceipt;

  try {
    const pdf = await createPDF(receipt);
    const file = new File(
      [pdf.output("blob")],
      pdfFilename(receipt),
      { type: "application/pdf" }
    );

    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({
        title: "Comprobante de préstamo",
        text: `Comprobante ${receipt.folio} de Préstamos La Bendición`,
        files: [file]
      });

      $("receiptMessage").textContent =
        "Se abrió el menú para compartir el comprobante.";
      return;
    }

    pdf.save(pdfFilename(receipt));

    const message = encodeURIComponent(
      `Hola. Le compartimos su comprobante de préstamo ${receipt.folio} de Préstamos La Bendición. Adjuntaremos el PDF correspondiente.`
    );

    const client = clientById(receipt.clienteId);
    const phone = /^\d{10}$/.test(client?.telefono || "")
      ? `52${client.telefono}`
      : "";

    window.open(
      `https://wa.me/${phone}?text=${message}`,
      "_blank",
      "noopener,noreferrer"
    );

    $("receiptMessage").textContent =
      "Se descargó el PDF y se abrió WhatsApp. Adjunta el archivo descargado antes de enviar.";
  } catch (error) {
    if (error.name !== "AbortError") {
      $("receiptMessage").textContent = error.message;
    }
  }
}

function printReceipt() {
  if (!selectedReceipt) return;
  const receipt = selectedReceipt;

  const popup = window.open("", "_blank");

  if (!popup) {
    $("receiptMessage").textContent =
      "Permite las ventanas emergentes para imprimir el comprobante.";
    return;
  }

  const body = $("receiptPreview").innerHTML;

  popup.document.write(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Recibo ${receipt.folio}</title>
      <link rel="stylesheet" href="${new URL("css/prestamos-extra.css", location.href).href}">
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .receipt-paper { box-shadow: none; max-width: 750px; margin: auto; }
      </style>
    </head>
    <body>${body}</body>
    </html>
  `);

  popup.document.close();
  popup.addEventListener("load", () => {
    popup.focus();
    popup.print();
  }, { once: true });
}

function closeMenu() {
  $("sidebar").classList.remove("open");
  $("overlay").classList.remove("show");
}

$("menuButton").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("overlay").classList.add("show");
});

$("overlay").addEventListener("click", closeMenu);
$("newLoan").addEventListener("click", openLoanModal);
$("closeModal").addEventListener("click", closeLoanModal);
$("cancelButton").addEventListener("click", closeLoanModal);
$("loanForm").addEventListener("submit", registerLoan);
$("search").addEventListener("input", renderLoans);
$("filter").addEventListener("change", renderLoans);

$("clienteId").addEventListener("change", () => {
  renderEmployees(clientById($("clienteId").value)?.empleadoId || "");
});

for (const id of [
  "capital",
  "totalPactado",
  "abono",
  "intervaloDias",
  "fechaEntrega"
]) {
  $(id).addEventListener("input", updateSchedule);
  $(id).addEventListener("change", updateSchedule);
}

$("closeReceipt").addEventListener("click", closeReceipt);
$("downloadReceipt").addEventListener("click", downloadPDF);
$("shareReceipt").addEventListener("click", sharePDF);
$("printReceipt").addEventListener("click", printReceipt);

$("loanModal").addEventListener("click", event => {
  if (event.target === $("loanModal")) closeLoanModal();
});

$("receiptModal").addEventListener("click", event => {
  if (event.target === $("receiptModal")) closeReceipt();
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (!$("receiptModal").hidden) closeReceipt();
  else if (!$("loanModal").hidden) closeLoanModal();
});

$("logout").addEventListener("click", async () => {
  await signOut(auth);
  location.replace("index.html");
});

function cleanup() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
}

onAuthStateChanged(auth, async user => {
  const version = ++sessionVersion;
  cleanup();

  if (!user) {
    $("app").hidden = true;
    location.replace("index.html");
    return;
  }

  currentUser = user;

  try {
    const profileRef = doc(db, "usuarios", user.uid);
    const profile = await getDoc(profileRef);

    if (version !== sessionVersion) return;

    if (
      !profile.exists() ||
      profile.data().estado !== "activo" ||
      profile.data().rol !== "admin"
    ) {
      location.replace("index.html");
      return;
    }

    administratorName = profile.data().nombre;
    $("adminName").textContent = administratorName;

    const subscribe = (reference, callback) => {
      const unsubscribe = onSnapshot(reference, snapshot => {
        if (version === sessionVersion) callback(snapshot);
      }, error => {
        $("loading").querySelector("p").textContent =
          "ERROR DE ACCESO A FIRESTORE";
        toast(error.message);
      });
      unsubscribers.push(unsubscribe);
    };

    subscribe(profileRef, snapshot => {
      if (
        !snapshot.exists() ||
        snapshot.data().estado !== "activo" ||
        snapshot.data().rol !== "admin"
      ) {
        $("app").hidden = true;
        location.replace("index.html");
      }
    });

    subscribe(collection(db, "clientes"), snapshot => {
      clients = snapshot.docs.map(item => ({
        ...item.data(),
        id: item.id
      }));
      if (!$("loanModal").hidden) renderClients();
    });

    subscribe(collection(db, "usuarios"), snapshot => {
      employees = snapshot.docs.map(item => ({
        ...item.data(),
        uid: item.id
      }));
      if (!$("loanModal").hidden) {
        renderEmployees($("empleadoId").value);
      }
      renderLoans();
    });

    subscribe(collection(db, "recibosPrestamo"), snapshot => {
      receipts = new Map(
        snapshot.docs.map(item => [
          item.id,
          { ...item.data(), id: item.id }
        ])
      );
      renderLoans();
    });

    subscribe(collection(db, "prestamos"), snapshot => {
      loans = snapshot.docs.map(item => ({
        ...item.data(),
        id: item.id
      }));

      $("loading").hidden = true;
      $("app").hidden = false;
      renderLoans();
    });
  } catch (error) {
    $("loading").querySelector("p").textContent =
      "NO SE PUDO VERIFICAR EL ACCESO";
    toast(error.message);
  }
});


