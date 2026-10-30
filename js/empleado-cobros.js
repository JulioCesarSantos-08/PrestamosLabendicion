
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { repartoMovimiento } from "./desglose-abonos.js";

const $c = id => document.getElementById(id);

let user = null;
let profile = null;
let selectedLoan = null;
let selectedReceipt = null;
let saving = false;

const currency = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

function money(cents) {
  return currency.format((Number(cents) || 0) / 100);
}

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const part = type => parts.find(x => x.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateDisplay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "Sin fecha";
  return value.split("-").reverse().join("/");
}

function cents(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value).trim())) return null;
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0 || number > 999999999.99) {
    return null;
  }

  return Math.round(number * 100);
}

function normalize(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function node(tag, className = "", content = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== null) element.textContent = String(content);
  return element;
}

function message(value, error = false) {
  const element = $c("employeePaymentMessage");
  element.textContent = value;
  element.style.color = error ? "#a62f35" : "#46617d";
}

function notify(value) {
  const element = $c("toast");
  if (!element) return;

  element.textContent = value;
  element.classList.add("show");
  clearTimeout(notify.timer);

  notify.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 4000);
}

function showModal() {
  $c("employeePaymentModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function hideModal() {
  if (saving) return;

  $c("employeePaymentModal").hidden = true;
  document.body.style.overflow = "";
  selectedLoan = null;
}

function closeReceipt() {
  $c("employeeReceiptModal").hidden = true;
  document.body.style.overflow = "";
}

async function openPayment(loanId) {
  if (!user || !profile) {
    notify("Inicia sesión con una cuenta autorizada.");
    return;
  }

  selectedLoan = null;

  $c("employeePaymentForm").reset();
  $c("employeePaymentDate").value = today();
  $c("employeePaymentSummary").textContent = "Consultando saldo...";
  message("");
  showModal();

  try {
    const loanSnapshot = await getDoc(doc(db, "prestamos", loanId));

    if (!loanSnapshot.exists()) {
      throw new Error("El préstamo ya no existe.");
    }

    const loan = loanSnapshot.data();

    if (loan.empleadoId !== user.uid) {
      throw new Error("Este préstamo no está asignado a tu cuenta.");
    }

    if (
      loan.tipoCalculo !== "total_pactado_manual" ||
      !Number.isSafeInteger(loan.totalPactadoCentavos)
    ) {
      throw new Error("Este préstamo no tiene un total pactado válido.");
    }

    const balanceSnapshot = await getDoc(doc(db, "saldosPrestamo", loanId));

    const received = balanceSnapshot.exists()
      ? balanceSnapshot.data().abonadoCentavos
      : 0;

    if (!Number.isSafeInteger(received) ||
      received < 0 ||
      received > loan.totalPactadoCentavos) {
      throw new Error("No se pudo verificar el saldo.");
    }

    const pending = loan.totalPactadoCentavos - received;

    if (pending <= 0) {
      throw new Error("Este préstamo ya tiene cubierto el total pactado.");
    }

    selectedLoan = {
      id: loanSnapshot.id,
      ...loan,
      saldoDisponible: pending
    };

    const summary = $c("employeePaymentSummary");
    summary.replaceChildren();

    summary.append(node("span", "", loan.clienteNombre));
    summary.append(node("strong", "", money(pending)));
    summary.append(node("p", "", `Folio: ${loan.folio}`));
    summary.append(node("p", "", `Abono previsto: ${money(loan.abonoCentavos)}`));

    $c("employeePaymentAmount").value =
      (Math.min(pending, loan.abonoCentavos) / 100).toFixed(2);

    $c("employeePaymentAmount").max = (pending / 100).toFixed(2);
  } catch (error) {
    message(error.message, true);
    $c("employeePaymentSummary").textContent =
      "No se pudo preparar este préstamo.";
  }
}

async function savePayment(event) {
  event.preventDefault();

  if (saving || !user || !profile || !selectedLoan) {
    message("Primero selecciona un préstamo autorizado.", true);
    return;
  }

  const amount = cents($c("employeePaymentAmount").value);
  const date = $c("employeePaymentDate").value;
  const method = $c("employeePaymentMethod").value;
  const note = normalize($c("employeePaymentNote").value);

  if (amount === null) {
    message("Introduce una cantidad válida.", true);
    return;
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date > today() ||
    date < selectedLoan.fechaEntrega
  ) {
    message("La fecha del pago no es válida.", true);
    return;
  }

  if (!["efectivo", "transferencia"].includes(method)) {
    message("Selecciona el medio de pago.", true);
    return;
  }

  if (note.length > 300) {
    message("Las observaciones son demasiado largas.", true);
    return;
  }

  if (!$c("employeePaymentConfirm").checked) {
    message("Confirma que recibiste el dinero.", true);
    return;
  }

  saving = true;
  $c("employeePaymentSave").disabled = true;
  $c("employeePaymentSave").textContent = "Guardando...";
  message("");

  const loanId = selectedLoan.id;
  const loanRef = doc(db, "prestamos", loanId);
  const clientRef = doc(db, "clientes", selectedLoan.clienteId);
  const balanceRef = doc(db, "saldosPrestamo", loanId);
  const controlRef = doc(db, "prestamoControl", loanId);
  const fondoRef = doc(db, "configuracionFondo", "principal");

  const paymentRef = doc(collection(db, "pagos"));
  const receiptRef = doc(db, "recibosAbono", paymentRef.id);

  let committed = false;

  try {
    await runTransaction(db, async transaction => {
      const loanSnapshot = await transaction.get(loanRef);
      const controlSnapshot = await transaction.get(controlRef);
      const clientSnapshot = await transaction.get(clientRef);
      const balanceSnapshot = await transaction.get(balanceRef);
      const fondoSnapshot = await transaction.get(fondoRef);

      if (!loanSnapshot.exists() || !clientSnapshot.exists()) {
        throw new Error("No se encontró el préstamo o cliente.");
      }

      const loan = loanSnapshot.data();

      const estadoPrestamo = controlSnapshot.exists()
        ? controlSnapshot.data().estado
        : "activo";

      if (estadoPrestamo !== "activo") {
        throw new Error(
          estadoPrestamo === "pausado"
            ? "El préstamo está pausado. No se pueden registrar abonos."
            : estadoPrestamo === "cancelado"
              ? "El préstamo está cancelado. No se pueden registrar abonos."
              : "El préstamo no tiene un estado autorizado para cobrar."
        );
      }

      if (
        loan.empleadoId !== user.uid ||
        clientSnapshot.data().empleadoId !== user.uid
      ) {
        throw new Error("El préstamo ya no está autorizado para este cobrador.");
      }

      if (
        loan.tipoCalculo !== "total_pactado_manual" ||
        !Number.isSafeInteger(loan.totalPactadoCentavos)
      ) {
        throw new Error("La deuda no tiene un total válido.");
      }

      const previous = balanceSnapshot.exists()
        ? balanceSnapshot.data().abonadoCentavos
        : 0;

      const count = balanceSnapshot.exists()
        ? balanceSnapshot.data().cantidadAbonos
        : 0;

      const total = loan.totalPactadoCentavos;

      if (
        !Number.isSafeInteger(previous) ||
        !Number.isSafeInteger(count) ||
        previous < 0 ||
        previous > total ||
        amount > total - previous
      ) {
        throw new Error("El importe supera el saldo disponible.");
      }

      const nextReceived = previous + amount;
      const nextBalance = total - nextReceived;

      if (!fondoSnapshot.exists()) {
        throw new Error("No existe el Fondo de Préstamos.");
      }

      const fondo = fondoSnapshot.data();
      const disponible = fondo.saldoDisponibleCentavos ??
        fondo.saldoInicialCentavos;

      const desgloseFondo = repartoMovimiento(
        loan.capitalCentavos,
        total,
        amount,
        nextBalance
      );

      if (!desgloseFondo ||
          !Number.isSafeInteger(disponible) ||
          disponible < 0 ||
          !Number.isSafeInteger(desgloseFondo.aCapitalCentavos) ||
          desgloseFondo.aCapitalCentavos < 0) {
        throw new Error(
          "FONDO_RECUPERACION_CAPITAL: No se pudo validar la recuperacion."
        );
      }

      const disponibleActualizado =
        disponible + desgloseFondo.aCapitalCentavos;

      if (!Number.isSafeInteger(disponibleActualizado)) {
        throw new Error("El fondo excede el limite numerico permitido.");
      }

      const payment = {
        prestamoId: loanId,
        folioPrestamo: loan.folio,
        clienteId: loan.clienteId,
        clienteNombre: loan.clienteNombre,
        montoCentavos: amount,
        saldoPosteriorCentavos: nextBalance,
        fechaPago: date,
        medio: method,
        nota: note,
        creadoPor: user.uid,
        cobradorNombre: profile.nombre,
        creadoEn: serverTimestamp()
      };

      transaction.set(balanceRef, {
        prestamoId: loanId,
        totalCentavos: total,
        abonadoCentavos: nextReceived,
        cantidadAbonos: count + 1,
        ultimoPagoId: paymentRef.id,
        actualizadoEn: serverTimestamp()
      });

      transaction.set(paymentRef, payment);
      transaction.set(receiptRef, {
        ...payment,
        tipo: "abono"
      });

      transaction.update(fondoRef, {
        saldoDisponibleCentavos: disponibleActualizado,
        ultimoPagoFondoId: paymentRef.id
      });
    });

    committed = true;
    saving = false;
    hideModal();
    notify("Abono registrado correctamente.");

    const saved = await getDoc(receiptRef);

    if (saved.exists()) {
      showReceipt({ ...saved.data(), id: saved.id });
    }
  } catch (error) {
    message(
      committed
        ? "El abono se guardó. Puedes consultarlo en tu historial."
        : error.code === "permission-denied"
          ? "Firebase rechazó el cobro. Verifica la autorización del préstamo."
          : error.message,
      true
    );
  } finally {
    saving = false;
    $c("employeePaymentSave").disabled = false;
    $c("employeePaymentSave").textContent = "Confirmar abono y generar recibo";
  }
}

async function calcularDesgloseRecibo(receipt) {
  try {
    const resultado = await getDoc(
      doc(db, "prestamos", receipt.prestamoId)
    );

    if (!resultado.exists()) return null;

    const prestamo = resultado.data();

    return repartoMovimiento(
      prestamo.capitalCentavos,
      prestamo.totalPactadoCentavos,
      receipt.montoCentavos,
      receipt.saldoPosteriorCentavos
    );
  } catch {
    return null;
  }
}
function receiptRow(label, value) {
  const row = node("div", "employee-receipt-row");
  row.append(node("span", "", label));
  row.append(node("strong", "", value));
  return row;
}

async function showReceipt(receipt) {
  selectedReceipt = receipt;

  const desglose = await calcularDesgloseRecibo(receipt);

  const paper = node("article", "employee-receipt-paper");
  const header = node("div", "employee-receipt-brand");

  const image = document.createElement("img");
  image.src = "imagenes/logo.png";
  image.alt = "Préstamos La Bendición";

  header.append(image);
  header.append(node("h3", "", "PRÉSTAMOS LA BENDICIÓN"));
  header.append(node("p", "", "COMPROBANTE DE ABONO"));

  paper.append(header);
  paper.append(receiptRow("Folio de préstamo", receipt.folioPrestamo));
  paper.append(receiptRow("Folio de abono", receipt.id));
  paper.append(receiptRow("Cliente", receipt.clienteNombre));
  paper.append(receiptRow("Fecha", dateDisplay(receipt.fechaPago)));
  paper.append(receiptRow("Medio", receipt.medio.toUpperCase()));
  if (desglose) {
    paper.append(receiptRow(
      "A capital",
      money(desglose.aCapitalCentavos)
    ));

    paper.append(receiptRow(
      "A intereses",
      money(desglose.aInteresesCentavos)
    ));
  } else {
    paper.append(receiptRow(
      "Desglose",
      "No disponible para este préstamo"
    ));
  }

  paper.append(receiptRow("Cobrador", receipt.cobradorNombre));
  paper.append(receiptRow("Saldo pendiente", money(receipt.saldoPosteriorCentavos)));

  const total = node("div", "employee-receipt-total");
  total.append(node("span", "", "ABONO RECIBIDO"));
  total.append(node("strong", "", money(receipt.montoCentavos)));
  paper.append(total);

  paper.append(node(
    "p",
    "employee-receipt-legal",
    "Comprobante de abono registrado digitalmente. El saldo se calcula sobre el total pactado, con separacion proporcional de capital e intereses cuando los datos estan disponibles."
  ));

  paper.append(node("p", "employee-receipt-legal", "Cualquier duda o inconveniente, comunicarse al 954 148 9953."));
  $c("employeeReceiptContent").replaceChildren(paper);
  $c("employeeReceiptMessage").textContent = "";
  $c("employeeReceiptModal").hidden = false;
  document.body.style.overflow = "hidden";
}

async function generatePDF(receipt) {
  if (!window.jspdf?.jsPDF) {
    throw new Error("No se pudo cargar el generador PDF.");
  }

  const desglose = await calcularDesgloseRecibo(receipt);

  const pdf = new window.jspdf.jsPDF();
  pdf.setFillColor(6, 29, 61);
  pdf.rect(0, 0, 210, 43, "F");

  pdf.setTextColor(231, 196, 127);
  pdf.setFont("times", "bold");
  pdf.setFontSize(17);
  pdf.text("PRESTAMOS LA BENDICION", 105, 20, { align: "center" });

  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text("RECIBO DE ABONO", 105, 29, { align: "center" });

  let y = 61;

  function line(label, value) {
    const safe = String(value ?? "").normalize("NFC")
      .replace(/[^\x20-\xFF]/g, " ");

    const lines = pdf.splitTextToSize(safe, 95);

    pdf.setTextColor(97, 112, 132);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text(label, 15, y);

    pdf.setTextColor(6, 29, 61);
    pdf.setFont("helvetica", "bold");
    pdf.text(lines, 97, y);

    y += Math.max(11, lines.length * 5 + 5);
  }

  line("Folio del prestamo", receipt.folioPrestamo);
  line("Folio del abono", receipt.id);
  line("Cliente", receipt.clienteNombre);
  line("Fecha", dateDisplay(receipt.fechaPago));
  line("Medio", receipt.medio.toUpperCase());
  if (desglose) {
    line("A capital", money(desglose.aCapitalCentavos));
    line("A intereses", money(desglose.aInteresesCentavos));
  } else {
    line("Desglose", "No disponible");
  }

  line("Cobrador", receipt.cobradorNombre);
  line("Saldo posterior", money(receipt.saldoPosteriorCentavos));

  pdf.setFillColor(6, 29, 61);
  pdf.roundedRect(15, y + 4, 180, 25, 3, 3, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(10);
  pdf.text("ABONO RECIBIDO", 21, y + 19);
  pdf.setTextColor(231, 196, 127);
  pdf.setFontSize(18);
  pdf.text(money(receipt.montoCentavos), 188, y + 19, { align: "right" });

  pdf.setTextColor(100, 110, 130);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.text(
    pdf.splitTextToSize(
      "Este comprobante corresponde a un abono registrado digitalmente. El saldo se calcula sobre el total pactado.",
      175
    ),
    17,
    y + 45
  );

  pdf.setTextColor(90, 105, 125);
  pdf.setFontSize(8);
  pdf.text("Dudas o inconvenientes: 954 148 9953", 105, 274, { align: "center" });
  return pdf;
}

async function downloadReceipt() {
  if (!selectedReceipt) return;

  try {
    const pdf = await generatePDF(selectedReceipt);
    pdf.save(`ABONO-${selectedReceipt.id}.pdf`);
  } catch (error) {
    $c("employeeReceiptMessage").textContent = error.message;
  }
}

async function shareReceipt() {
  if (!selectedReceipt) return;

  const receipt = selectedReceipt;

  try {
    const pdf = await generatePDF(receipt);
    const filename = `ABONO-${receipt.id}.pdf`;

    const file = new File([pdf.output("blob")], filename, {
      type: "application/pdf"
    });

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        title: "Recibo de abono",
        text: `Recibo ${receipt.id} de Préstamos La Bendición`,
        files: [file]
      });
      return;
    }

    pdf.save(filename);

    const clientSnapshot = await getDoc(doc(db, "clientes", receipt.clienteId));
    const telephone = clientSnapshot.exists()
      ? clientSnapshot.data().telefono
      : "";

    const phone = /^\d{10}$/.test(telephone)
      ? `52${telephone}`
      : "";

    const msg = encodeURIComponent(
      `Le compartimos el comprobante de su abono. Folio: ${receipt.id}. Adjuntaremos el PDF correspondiente.`
    );

    window.open(
      `https://wa.me/${phone}?text=${msg}`,
      "_blank",
      "noopener,noreferrer"
    );

    $c("employeeReceiptMessage").textContent =
      "Se descargó el PDF. Adjunta el archivo en WhatsApp antes de enviar.";
  } catch (error) {
    if (error.name !== "AbortError") {
      $c("employeeReceiptMessage").textContent = error.message;
    }
  }
}

async function loadMyPayments() {
  if (!user) return;

  const container = $c("employeePaymentHistory");
  container.replaceChildren(node("p", "", "Consultando pagos..."));

  try {
    const snapshot = await getDocs(query(
      collection(db, "pagos"),
      where("creadoPor", "==", user.uid)
    ));

    const payments = snapshot.docs.map(item => ({
      ...item.data(),
      id: item.id
    }));

    payments.sort((a, b) =>
      (b.creadoEn?.toMillis?.() || 0) -
      (a.creadoEn?.toMillis?.() || 0)
    );

    container.replaceChildren();

    if (!payments.length) {
      container.append(node("p", "", "Todavía no tienes abonos registrados."));
      return;
    }

    for (const payment of payments) {
      const card = node("div", "employee-history-item");
      card.append(node("strong", "", payment.clienteNombre));
      card.append(node("span", "", `${dateDisplay(payment.fechaPago)} · ${money(payment.montoCentavos)}`));

      const button = node("button", "card-button", "Ver recibo");
      button.type = "button";

      button.addEventListener("click", async () => {
        try {
          const saved = await getDoc(doc(db, "recibosAbono", payment.id));
          if (saved.exists()) {
            showReceipt({ ...saved.data(), id: saved.id });
          }
        } catch {
          notify("No se pudo recuperar el comprobante.");
        }
      });

      card.append(button);
      container.append(card);
    }
  } catch (error) {
    container.replaceChildren(node(
      "p",
      "",
      "No se pudo consultar el historial: " + error.message
    ));
  }
}

function installUI() {
  const modal = document.createElement("div");
  modal.id = "employeePaymentModal";
  modal.className = "employee-payment-backdrop";
  modal.hidden = true;

  modal.innerHTML = `
    <section class="employee-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="employeePaymentTitle">
      <header class="employee-payment-header">
        <div>
          <small>PRÉSTAMOS LA BENDICIÓN</small>
          <h2 id="employeePaymentTitle">Registrar abono</h2>
        </div>
        <button id="employeePaymentClose" type="button" aria-label="Cerrar">×</button>
      </header>
      <form id="employeePaymentForm">
        <div class="employee-payment-body">
          <div class="employee-payment-summary" id="employeePaymentSummary"></div>
          <label for="employeePaymentAmount">Importe recibido (MXN)</label>
          <input id="employeePaymentAmount" type="number" min="0.01" step="0.01" required>
          <label for="employeePaymentDate">Fecha del pago</label>
          <input id="employeePaymentDate" type="date" required>
          <label for="employeePaymentMethod">Medio de pago</label>
          <select id="employeePaymentMethod" required>
            <option value="efectivo">Efectivo</option>
            <option value="transferencia">Transferencia</option>
          </select>
          <label for="employeePaymentNote">Observaciones</label>
          <textarea id="employeePaymentNote" maxlength="300" rows="2"></textarea>
          <label class="employee-payment-confirm">
            <input id="employeePaymentConfirm" type="checkbox" required>
            Confirmo que recibí el dinero indicado.
          </label>
          <p id="employeePaymentMessage" role="alert"></p>
        </div>
        <footer class="employee-payment-footer">
          <button type="button" id="employeePaymentCancel">Cancelar</button>
          <button type="submit" id="employeePaymentSave">Confirmar abono y generar recibo</button>
        </footer>
      </form>
    </section>
  `;

  const receipt = document.createElement("div");
  receipt.id = "employeeReceiptModal";
  receipt.className = "employee-payment-backdrop";
  receipt.hidden = true;

  receipt.innerHTML = `
    <section class="employee-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="employeeReceiptTitle">
      <header class="employee-payment-header">
        <div>
          <small>COMPROBANTE DIGITAL</small>
          <h2 id="employeeReceiptTitle">Recibo de abono</h2>
        </div>
        <button type="button" id="employeeReceiptClose" aria-label="Cerrar">×</button>
      </header>
      <div id="employeeReceiptContent"></div>
      <footer class="employee-payment-footer">
        <button id="employeeDownloadReceipt" type="button">Descargar PDF</button>
        <button id="employeeShareReceipt" type="button">Compartir / WhatsApp</button>
      </footer>
      <p id="employeeReceiptMessage"></p>
    </section>
  `;

  const history = document.createElement("section");
  history.className = "employee-payment-history-box";
  history.innerHTML = `
    <div class="employee-payment-history-heading">
      <h2>Mis abonos registrados</h2>
      <button type="button" id="employeeReloadHistory">Actualizar</button>
    </div>
    <div id="employeePaymentHistory"></div>
  `;

  document.body.append(modal, receipt);

  const section = document.getElementById("loansSection");
  if (section) section.append(history);

  $c("employeePaymentClose").addEventListener("click", hideModal);
  $c("employeePaymentCancel").addEventListener("click", hideModal);
  $c("employeePaymentForm").addEventListener("submit", savePayment);
  $c("employeeReceiptClose").addEventListener("click", closeReceipt);
  $c("employeeDownloadReceipt").addEventListener("click", downloadReceipt);
  $c("employeeShareReceipt").addEventListener("click", shareReceipt);
  $c("employeeReloadHistory").addEventListener("click", loadMyPayments);

  modal.addEventListener("click", event => {
    if (event.target === modal) hideModal();
  });

  receipt.addEventListener("click", event => {
    if (event.target === receipt) closeReceipt();
  });
}

installUI();

document.addEventListener("click", event => {
  const button = event.target.closest("[data-employee-collect]");

  if (!button || button.disabled || !user) return;

  openPayment(button.dataset.employeeCollect);
});

onAuthStateChanged(auth, async account => {
  user = null;
  profile = null;

  if (!account) return;

  try {
    const snapshot = await getDoc(doc(db, "usuarios", account.uid));

    if (
      snapshot.exists() &&
      snapshot.data().estado === "activo" &&
      snapshot.data().rol === "empleado"
    ) {
      user = account;
      profile = snapshot.data();
      loadMyPayments();
    }
  } catch (error) {
    console.error("Error de autorización de cobranza:", error);
  }
});




