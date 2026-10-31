
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
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { repartoMovimiento } from "./desglose-abonos.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let adminName = "";
let loans = [];
let balances = new Map();
let payments = [];
let receipts = new Map();
let clients = [];
let busy = false;
let selectedReceipt = null;
let unsubscribers = [];
let version = 0;
let loaded = { loans: false, balances: false, payments: false, receipts: false };

const formatMoney = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

function money(cents) {
  return formatMoney.format((Number(cents) || 0) / 100);
}

function normalize(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function make(tag, className = "", content) {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 4000);
}

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(new Date());

  const part = type => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function dateDisplay(value) {
  if (!validDate(value)) return "Sin fecha";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function cents(value) {
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

function balanceFor(loan) {
  if (!Number.isSafeInteger(loan.totalPactadoCentavos)) return null;

  const state = balances.get(loan.id);
  const received = state?.abonadoCentavos || 0;

  if (!Number.isSafeInteger(received)) return null;

  return Math.max(0, loan.totalPactadoCentavos - received);
}

function loanById(id) {
  return loans.find(loan => loan.id === id);
}

function paymentReady(loan) {
  return Number.isSafeInteger(loan.totalPactadoCentavos) &&
    Number.isSafeInteger(loan.capitalCentavos) &&
    loan.tipoCalculo === "total_pactado_manual" &&
    balanceFor(loan) !== null;
}

function render() {
  if (!Object.values(loaded).every(Boolean)) return;

  const supported = loans.filter(paymentReady);
  const received = payments.reduce(
    (sum, payment) => sum + (Number(payment.montoCentavos) || 0),
    0
  );
  const pending = supported.reduce(
    (sum, loan) => sum + balanceFor(loan),
    0
  );

  $("collectedTotal").textContent = money(received);
  $("pendingTotal").textContent = money(pending);
  $("paymentsCount").textContent = payments.length;
  $("paidLoans").textContent = supported.filter(loan => balanceFor(loan) === 0).length;

  const search = $("searchLoans").value.trim().toLocaleUpperCase("es-MX");
  const filter = $("filterLoans").value;

  const visible = loans.filter(loan => {
    const term = `${loan.folio || ""} ${loan.clienteNombre || ""}`.toLocaleUpperCase("es-MX");
    if (!term.includes(search)) return false;
    const balance = balanceFor(loan);
    if (filter === "pendientes") return balance !== null && balance > 0;
    if (filter === "liquidados") return balance === 0;
    if (filter === "sinConfigurar") return !paymentReady(loan);
    return true;
  });

  const container = $("loansList");
  container.replaceChildren();

  if (!visible.length) {
    container.append(make("div", "payment-empty", "No hay préstamos que coincidan con el filtro."));
  }

  for (const loan of visible) {
    const balance = balanceFor(loan);
    const supportedLoan = paymentReady(loan);
    const row = make("article", "pay-loan");
    const main = make("div");
    const side = make("div", "pay-numbers");

    main.append(make("span", "pay-folio", loan.folio || loan.id));
    main.append(make("h4", "", loan.clienteNombre || "CLIENTE"));
    main.append(make("div", "pay-meta",
      `Capital: ${money(loan.capitalCentavos)} · Total pactado: ${
        Number.isSafeInteger(loan.totalPactadoCentavos) ? money(loan.totalPactadoCentavos) : "No definido"
      }`
    ));

    const tags = make("div", "pay-tags");

    if (!supportedLoan) {
      tags.append(make("span", "pay-tag warning", "Requiere configurar total pactado"));
    } else if (balance === 0) {
      tags.append(make("span", "pay-tag paid", "Total pactado cubierto"));
    } else {
      tags.append(make("span", "pay-tag", `Abonos: ${balances.get(loan.id)?.cantidadAbonos || 0}`));
      tags.append(make("span", "pay-tag", `Cada ${loan.intervaloDias} días`));
    }

    main.append(tags);

    side.append(make("span", "", "Saldo pactado pendiente"));
    side.append(make("strong", "", balance === null ? "—" : money(balance)));

    const button = make("button", "", balance === 0 ? "Cubierto" : "Registrar abono");
    button.type = "button";
    button.disabled = !supportedLoan || balance === 0;
    button.addEventListener("click", () => openPayment(loan.id));
    side.append(button);

    row.append(main, side);
    container.append(row);
  }

  const history = $("paymentsList");
  history.replaceChildren();

  const sorted = [...payments].sort((a, b) =>
    (b.creadoEn?.toMillis?.() || 0) - (a.creadoEn?.toMillis?.() || 0)
  );

  if (!sorted.length) {
    history.append(make("div", "payment-empty", "Todavía no hay abonos registrados."));
  }

  for (const payment of sorted) {
    const row = make("article", "payment-row");
    const main = make("div", "payment-row-main");
    const side = make("div", "payment-row-side");

    main.append(make("strong", "", payment.clienteNombre));
    main.append(make("span", "",
      `${payment.folioPrestamo} · ${dateDisplay(payment.fechaPago)} · ${payment.medio === "efectivo" ? "Efectivo" : "Transferencia"}`
    ));
    main.append(make("span", "", `Folio de abono: ${payment.id}`));

    side.append(make("strong", "", money(payment.montoCentavos)));

    const button = make("button", "", "Ver recibo");
    button.type = "button";
    button.disabled = !receipts.has(payment.id);
    button.addEventListener("click", () => showReceipt(receipts.get(payment.id)));
    side.append(button);

    row.append(main, side);
    history.append(row);
  }
}

function fillLoanOptions(selected = "") {
  $("paymentLoan").replaceChildren(new Option("Selecciona un préstamo", ""));

  for (const loan of loans.filter(loan => paymentReady(loan) && balanceFor(loan) > 0)) {
    $("paymentLoan").add(new Option(
      `${loan.clienteNombre} · ${loan.folio}`,
      loan.id
    ));
  }

  $("paymentLoan").value = selected || "";
  updateSummary();
}

function updateSummary() {
  const loan = loanById($("paymentLoan").value);
  const box = $("paymentSummary");
  box.replaceChildren();

  if (!loan) {
    box.textContent = "Selecciona un préstamo para consultar el saldo.";
    return;
  }

  const balance = balanceFor(loan);

  box.append(make("span", "", "Saldo actual del total pactado"));
  box.append(make("strong", "", money(balance)));
  box.append(make("p", "", `Abono previsto: ${money(loan.abonoCentavos)}`));
  box.append(make("p", "", `Fecha final prevista: ${dateDisplay(loan.fechaFin)}`));

  if (balance > 0) {
    $("paymentAmount").value = (Math.min(balance, loan.abonoCentavos) / 100).toFixed(2);
    $("paymentAmount").max = (balance / 100).toFixed(2);
  }
}

function openPayment(selected = "") {
  $("paymentForm").reset();
  $("paymentError").textContent = "";
  $("paymentDate").value = today();
  fillLoanOptions(selected);
  $("paymentModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closePayment() {
  if (busy) return;
  $("paymentModal").hidden = true;
  document.body.style.overflow = "";
}

async function savePayment(event) {
  event.preventDefault();
  if (busy || !currentUser) return;

  const loan = loanById($("paymentLoan").value);
  const amount = cents($("paymentAmount").value);
  const paymentDate = $("paymentDate").value;
  const method = $("paymentMethod").value;
  const note = normalize($("paymentNote").value);

  const fail = message => {
    $("paymentError").textContent = message;
  };

  if (!loan || !paymentReady(loan)) return fail("Selecciona un préstamo con total pactado.");
  if (amount === null) return fail("Ingresa un importe válido.");
  if (!validDate(paymentDate)) return fail("Fecha de pago inválida.");
  if (paymentDate > today()) return fail("No puedes registrar un pago futuro.");
  if (paymentDate < loan.fechaEntrega) return fail("El abono no puede ser anterior a la entrega.");
  if (!["efectivo", "transferencia"].includes(method)) return fail("Selecciona un medio de pago.");
  if (note.length > 300) return fail("Observaciones demasiado largas.");
  if (!$("confirmPayment").checked) return fail("Confirma que recibiste el dinero.");

  busy = true;
  $("savePayment").disabled = true;
  $("savePayment").textContent = "Registrando...";
  $("paymentError").textContent = "";

  const paymentRef = doc(collection(db, "pagos"));
  const receiptRef = doc(db, "recibosAbono", paymentRef.id);
  const balanceRef = doc(db, "saldosPrestamo", loan.id);
  const loanRef = doc(db, "prestamos", loan.id);
  const controlRef = doc(db, "prestamoControl", loan.id);
  const fondoRef = doc(db, "configuracionFondo", "principal");

  let committed = false;

  try {
    await runTransaction(db, async transaction => {
      const loanSnapshot = await transaction.get(loanRef);
      const controlSnapshot = await transaction.get(controlRef);
      const balanceSnapshot = await transaction.get(balanceRef);
      const fondoSnapshot = await transaction.get(fondoRef);

      if (!loanSnapshot.exists()) {
        throw new Error("El préstamo ya no existe.");
      }

      const actualLoan = loanSnapshot.data();

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
        actualLoan.tipoCalculo !== "total_pactado_manual" ||
        !Number.isSafeInteger(actualLoan.totalPactadoCentavos)
      ) {
        throw new Error("Este préstamo no tiene cobranza configurada.");
      }

      const total = actualLoan.totalPactadoCentavos;
      const previous = balanceSnapshot.exists()
        ? balanceSnapshot.data().abonadoCentavos
        : 0;
      const count = balanceSnapshot.exists()
        ? balanceSnapshot.data().cantidadAbonos
        : 0;

      if (
        !Number.isSafeInteger(previous) ||
        previous < 0 ||
        previous > total ||
        amount > total - previous
      ) {
        throw new Error("El abono excede el saldo disponible.");
      }

      const newReceived = previous + amount;
      const newBalance = total - newReceived;

      if (!fondoSnapshot.exists()) {
        throw new Error("No existe el Fondo de Préstamos.");
      }

      const fondo = fondoSnapshot.data();
      const disponible = fondo.saldoDisponibleCentavos ??
        fondo.saldoInicialCentavos;

      const desgloseFondo = repartoMovimiento(
        actualLoan.capitalCentavos,
        total,
        amount,
        newBalance
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
        prestamoId: loan.id,
        folioPrestamo: actualLoan.folio,
        clienteId: actualLoan.clienteId,
        clienteNombre: actualLoan.clienteNombre,
        montoCentavos: amount,
        saldoPosteriorCentavos: newBalance,
        fechaPago: paymentDate,
        medio: method,
        nota: note,
        creadoPor: currentUser.uid,
        cobradorNombre: adminName,
        creadoEn: serverTimestamp()
      };

      const state = {
        prestamoId: loan.id,
        totalCentavos: total,
        abonadoCentavos: newReceived,
        cantidadAbonos: count + 1,
        ultimoPagoId: paymentRef.id,
        actualizadoEn: serverTimestamp()
      };

      transaction.set(balanceRef, state);
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
    busy = false;
    closePayment();
    toast("Abono y recibo guardados correctamente.");

    const savedReceipt = await getDoc(receiptRef);
    if (savedReceipt.exists()) {
      showReceipt({ ...savedReceipt.data(), id: savedReceipt.id });
    }
  } catch (error) {
    if (committed) {
      toast("El abono se guardó. Puedes abrir el recibo desde el historial.");
    } else {
      fail(
        error.code === "permission-denied"
          ? "Firebase rechazó el cobro. Revisa las reglas de seguridad."
          : error.message
      );
    }
  } finally {
    busy = false;
    $("savePayment").disabled = false;
    $("savePayment").textContent = "Guardar y generar recibo";
  }
}

function receiptLine(label, value) {
  const row = make("div", "payment-receipt-line");
  row.append(make("span", "", label));
  row.append(make("strong", "", value));
  return row;
}

function showReceipt(receipt) {
  selectedReceipt = receipt;

  const paper = make("div", "payment-receipt-paper");
  const head = make("div", "payment-receipt-header");
  const img = document.createElement("img");
  img.src = "imagenes/logo.png";
  img.alt = "Préstamos La Bendición";

  head.append(img);
  head.append(make("h3", "", "PRÉSTAMOS LA BENDICIÓN"));
  head.append(make("p", "", "RECIBO DE ABONO"));
  paper.append(head);

  paper.append(receiptLine("Folio del préstamo", receipt.folioPrestamo));
  paper.append(receiptLine("Folio del pago", receipt.id));
  paper.append(receiptLine("Cliente", receipt.clienteNombre));
  paper.append(receiptLine("Fecha del pago", dateDisplay(receipt.fechaPago)));
  paper.append(receiptLine("Medio de pago", receipt.medio.toUpperCase()));

  const prestamoRecibo = loans.find(item => item.id === receipt.prestamoId);

  const desgloseRecibo = prestamoRecibo
    ? repartoMovimiento(
        prestamoRecibo.capitalCentavos,
        prestamoRecibo.totalPactadoCentavos,
        receipt.montoCentavos,
        receipt.saldoPosteriorCentavos
      )
    : null;

  if (desgloseRecibo) {
    paper.append(receiptLine("A capital", money(desgloseRecibo.aCapitalCentavos)));
    paper.append(receiptLine("A intereses", money(desgloseRecibo.aInteresesCentavos)));
  }
  paper.append(receiptLine("Saldo después del abono", money(receipt.saldoPosteriorCentavos)));
  paper.append(receiptLine("Registró", receipt.cobradorNombre));

  const amount = make("div", "payment-receipt-amount");
  amount.append(make("span", "", "ABONO RECIBIDO"));
  amount.append(make("strong", "", money(receipt.montoCentavos)));
  paper.append(amount);

  if (receipt.nota) {
    paper.append(receiptLine("Observaciones", receipt.nota));
  }

  paper.append(make(
    "p",
    "payment-receipt-note",
    "Comprobante de abono registrado digitalmente. El importe y saldo corresponden al total pactado del préstamo, con separacion proporcional de capital e intereses."
  ));

  paper.append(make("p", "payment-receipt-note", "Cualquier duda o inconveniente, comunicarse al 954 148 9953."));
  $("receiptContent").replaceChildren(paper);
  $("receiptMessage").textContent = "El comprobante permanece registrado en Firestore.";
  $("receiptModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeReceipt() {
  selectedReceipt = null;
  $("receiptModal").hidden = true;
  document.body.style.overflow = "";
}

async function createPDF(receipt) {
  if (!window.jspdf?.jsPDF) {
    throw new Error("No se pudo cargar jsPDF.");
  }

  const pdf = new window.jspdf.jsPDF();
  const navy = [6, 29, 61];

  pdf.setFillColor(...navy);
  pdf.rect(0, 0, 210, 48, "F");

  pdf.setFont("times", "bold");
  pdf.setFontSize(18);
  pdf.setTextColor(230, 194, 125);
  pdf.text("PRESTAMOS LA BENDICION", 105, 21, { align: "center" });

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(255, 255, 255);
  pdf.text("COMPROBANTE DE ABONO", 105, 31, { align: "center" });

  pdf.setTextColor(...navy);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  pdf.text("RECIBO DE PAGO", 15, 63);

  let y = 78;

  function line(label, value) {
    const safe = String(value ?? "").normalize("NFC");
    const wrapped = pdf.splitTextToSize(safe, 95);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(label, 15, y);

    pdf.setFont("helvetica", "bold");
    pdf.text(wrapped, 96, y);

    y += Math.max(11, wrapped.length * 5 + 5);
  }

  line("Folio del prestamo", receipt.folioPrestamo);
  line("Folio del abono", receipt.id);
  line("Cliente", receipt.clienteNombre);
  line("Fecha del pago", dateDisplay(receipt.fechaPago));
  line("Medio de pago", receipt.medio.toUpperCase());

  const prestamoPDF = loans.find(item => item.id === receipt.prestamoId);

  const desglosePDF = prestamoPDF
    ? repartoMovimiento(
        prestamoPDF.capitalCentavos,
        prestamoPDF.totalPactadoCentavos,
        receipt.montoCentavos,
        receipt.saldoPosteriorCentavos
      )
    : null;

  if (desglosePDF) {
    line("A capital", money(desglosePDF.aCapitalCentavos));
    line("A intereses", money(desglosePDF.aInteresesCentavos));
  }
  line("Registrado por", receipt.cobradorNombre);
  line("Saldo posterior", money(receipt.saldoPosteriorCentavos));

  pdf.setFillColor(...navy);
  pdf.roundedRect(15, y + 3, 180, 24, 3, 3, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(11);
  pdf.text("ABONO RECIBIDO", 21, y + 18);
  pdf.setTextColor(232, 199, 128);
  pdf.setFontSize(20);
  pdf.text(money(receipt.montoCentavos), 188, y + 18, { align: "right" });

  pdf.setTextColor(105, 119, 140);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.text(
    pdf.splitTextToSize(
      "Comprobante digital de abono. El saldo corresponde al total pactado, con separacion proporcional de capital e intereses.",
      175
    ),
    16,
    y + 39
  );

  pdf.setDrawColor(201, 163, 90);
  pdf.line(15, 279, 195, 279);
  pdf.setFontSize(8);
  pdf.text("PRESTAMOS LA BENDICION", 105, 286, { align: "center" });

  pdf.setTextColor(90, 105, 125);
  pdf.setFontSize(8);
  pdf.text("Dudas o inconvenientes: 954 148 9953", 105, 274, { align: "center" });
  return pdf;
}

async function downloadReceipt() {
  if (!selectedReceipt) return;

  try {
    const pdf = await createPDF(selectedReceipt);
    pdf.save(`ABONO-${selectedReceipt.id}.pdf`);
    $("receiptMessage").textContent = "PDF generado correctamente.";
  } catch (error) {
    $("receiptMessage").textContent = error.message;
  }
}

async function shareReceipt() {
  if (!selectedReceipt) return;

  const receipt = selectedReceipt;

  try {
    const pdf = await createPDF(receipt);
    const file = new File(
      [pdf.output("blob")],
      `ABONO-${receipt.id}.pdf`,
      { type: "application/pdf" }
    );

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        title: "Recibo de abono",
        text: `Recibo ${receipt.id} de Préstamos La Bendición`,
        files: [file]
      });
      return;
    }

    pdf.save(file.name);

    const client = clients.find(item => item.id === receipt.clienteId);
    const phone = /^\d{10}$/.test(client?.telefono || "") ? `52${client.telefono}` : "";
    const message = encodeURIComponent(
      `Le compartimos su comprobante de abono de Préstamos La Bendición. Folio: ${receipt.id}. Adjuntaremos el PDF.`
    );

    window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener,noreferrer");

    $("receiptMessage").textContent =
      "Se descargó el PDF y se abrió WhatsApp. Adjunta el archivo antes de enviar.";
  } catch (error) {
    if (error.name !== "AbortError") {
      $("receiptMessage").textContent = error.message;
    }
  }
}

function cleanup() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
}

$("menuButton").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("overlay").classList.add("show");
});

$("overlay").addEventListener("click", () => {
  $("sidebar").classList.remove("open");
  $("overlay").classList.remove("show");
});

$("newPayment").addEventListener("click", () => openPayment());
$("closePayment").addEventListener("click", closePayment);
$("cancelPayment").addEventListener("click", closePayment);
$("paymentLoan").addEventListener("change", updateSummary);
$("paymentForm").addEventListener("submit", savePayment);
$("searchLoans").addEventListener("input", render);
$("filterLoans").addEventListener("change", render);
$("closeReceipt").addEventListener("click", closeReceipt);
$("downloadReceipt").addEventListener("click", downloadReceipt);
$("shareReceipt").addEventListener("click", shareReceipt);

$("logout").addEventListener("click", async () => {
  await signOut(auth);
  location.replace("index.html");
});

onAuthStateChanged(auth, async user => {
  cleanup();
  const currentVersion = ++version;

  if (!user) {
    location.replace("index.html");
    return;
  }

  try {
    const profileRef = doc(db, "usuarios", user.uid);
    const profile = await getDoc(profileRef);

    if (currentVersion !== version) return;

    if (
      !profile.exists() ||
      profile.data().rol !== "admin" ||
      profile.data().estado !== "activo"
    ) {
      location.replace("index.html");
      return;
    }

    currentUser = user;
    adminName = profile.data().nombre || "ADMINISTRADOR";
    $("adminName").textContent = adminName;

    const subscribe = (reference, callback) => {
      unsubscribers.push(
        onSnapshot(reference, snapshot => {
          if (currentVersion === version) callback(snapshot);
        }, error => {
          $("loading").querySelector("p").textContent =
            "NO SE PUDO CONSULTAR FIRESTORE";
          toast(error.message);
        })
      );
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
      clients = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    });

    subscribe(collection(db, "prestamos"), snapshot => {
      loans = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
      loaded.loans = true;
      render();
    });

    subscribe(collection(db, "saldosPrestamo"), snapshot => {
      balances = new Map(
        snapshot.docs.map(item => [item.id, item.data()])
      );
      loaded.balances = true;
      render();
    });

    subscribe(collection(db, "pagos"), snapshot => {
      payments = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
      loaded.payments = true;
      render();
    });

    subscribe(collection(db, "recibosAbono"), snapshot => {
      receipts = new Map(
        snapshot.docs.map(item => [
          item.id,
          { ...item.data(), id: item.id }
        ])
      );
      loaded.receipts = true;
      render();
    });

    $("loading").hidden = true;
    $("app").hidden = false;
  } catch (error) {
    $("loading").querySelector("p").textContent =
      "NO SE PUDO VERIFICAR EL ACCESO";
    toast(error.message);
  }
});
