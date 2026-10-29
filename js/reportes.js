
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const rp = id => document.getElementById(id);

const formato = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

const dinero = valor => formato.format((Number(valor) || 0) / 100);

let autorizado = false;
let prestamos = [];
let pagos = [];
let usuarios = [];
let saldos = [];
let movimientosVisibles = [];
let cargando = false;

function fechaLocal() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/Mexico_City"
  }).formatToParts(new Date());

  const valor = tipo => partes.find(p => p.type === tipo)?.value;
  return `${valor("year")}-${valor("month")}-${valor("day")}`;
}

function fechaMostrar(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor || "")
    ? valor.split("-").reverse().join("/")
    : "Sin fecha";
}

function centavos(valor) {
  return Number.isSafeInteger(valor) && valor >= 0 ? valor : 0;
}

function nodo(tipo, clase = "", texto = null) {
  const elemento = document.createElement(tipo);
  if (clase) elemento.className = clase;
  if (texto !== null) elemento.textContent = String(texto);
  return elemento;
}

function mostrarEstado(texto, error = false) {
  const elemento = rp("reportesEstado");
  if (!elemento) return;
  elemento.textContent = texto;
  elemento.classList.toggle("error", error);
}

function nombreCobrador(uid, alternativo = "") {
  const perfil = usuarios.find(u => u.id === uid);
  return perfil?.nombre || alternativo || "Sin asignar";
}

function todosLosSaldos() {
  const mapa = new Map(saldos.map(s => [s.id, s]));

  return prestamos.map(prestamo => {
    const saldo = mapa.get(prestamo.id);
    const capital = centavos(prestamo.capitalCentavos);
    const pactado = prestamo.totalPactadoCentavos;

    const completo =
      Number.isSafeInteger(prestamo.capitalCentavos) &&
      prestamo.capitalCentavos > 0 &&
      Number.isSafeInteger(pactado) &&
      pactado >= capital &&
      Number.isSafeInteger(saldo?.abonadoCentavos ?? 0) &&
      (saldo?.abonadoCentavos ?? 0) >= 0 &&
      (saldo?.abonadoCentavos ?? 0) <= pactado;

    const abonado = completo
      ? centavos(saldo?.abonadoCentavos)
      : 0;

    return {
      ...prestamo,
      capital,
      completo,
      total: completo ? pactado : 0,
      abonado,
      pendiente: completo ? pactado - abonado : 0
    };
  });
}

function crearTarjeta(titulo, cantidad, descripcion) {
  const contenedor = nodo("article", "rp-card");
  contenedor.append(
    nodo("span", "rp-card-label", titulo),
    nodo("strong", "rp-card-number", dinero(cantidad)),
    nodo("small", "rp-card-note", descripcion)
  );
  return contenedor;
}

function crearFila(valores, encabezado = false) {
  const fila = nodo("tr");

  for (const valor of valores) {
    fila.append(nodo(encabezado ? "th" : "td", "", valor));
  }

  return fila;
}

function periodoActual() {
  return {
    inicio: rp("reportesDesde").value,
    fin: rp("reportesHasta").value,
    empleado: rp("reportesEmpleado").value
  };
}

function filtrarMovimientos() {
  const { inicio, fin, empleado } = periodoActual();

  return pagos.filter(pago => {
    const fecha = pago.fechaPago || "";
    return (!inicio || fecha >= inicio)
      && (!fin || fecha <= fin)
      && (empleado === "todos" || pago.creadoPor === empleado);
  }).sort((a, b) =>
    (b.fechaPago || "").localeCompare(a.fechaPago || "") ||
    (b.creadoEn?.toMillis?.() || 0) -
    (a.creadoEn?.toMillis?.() || 0)
  );
}

function dibujarGrafica(movimientos) {
  const grafica = rp("reportesGrafica");
  grafica.replaceChildren();

  const grupos = new Map();

  for (const pago of movimientos) {
    const fecha = pago.fechaPago || "Sin fecha";
    grupos.set(fecha, (grupos.get(fecha) || 0) + centavos(pago.montoCentavos));
  }

  const datos = [...grupos.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12);

  if (!datos.length) {
    grafica.append(nodo("p", "rp-vacio", "No hay pagos para graficar en este periodo."));
    return;
  }

  const mayor = Math.max(...datos.map(item => item[1]), 1);

  for (const [fecha, valor] of datos) {
    const grupo = nodo("div", "rp-bar-group");
    const barra = nodo("div", "rp-bar");
    barra.style.height = `${Math.max(5, valor / mayor * 100)}%`;
    barra.title = `${fechaMostrar(fecha)}: ${dinero(valor)}`;

    grupo.append(
      nodo("strong", "rp-bar-value", dinero(valor)),
      barra,
      nodo("span", "rp-bar-label", fecha.slice(5))
    );

    grafica.append(grupo);
  }
}

function dibujarEmpleados(movimientos) {
  const cuerpo = rp("reportesEmpleados");
  cuerpo.replaceChildren();

  const grupos = new Map();

  for (const pago of movimientos) {
    const id = pago.creadoPor || "desconocido";

    if (!grupos.has(id)) {
      grupos.set(id, {
        nombre: nombreCobrador(id, pago.cobradorNombre),
        cantidad: 0,
        total: 0
      });
    }

    const grupo = grupos.get(id);
    grupo.cantidad++;
    grupo.total += centavos(pago.montoCentavos);
  }

  const datos = [...grupos.values()].sort((a, b) => b.total - a.total);

  if (!datos.length) {
    cuerpo.append(crearFila(["Sin movimientos", "0", dinero(0)]));
    return;
  }

  for (const dato of datos) {
    cuerpo.append(crearFila([
      dato.nombre,
      dato.cantidad,
      dinero(dato.total)
    ]));
  }
}

function dibujarMovimientos(movimientos) {
  const cuerpo = rp("reportesMovimientos");
  cuerpo.replaceChildren();

  rp("reportesCantidad").textContent =
    `${movimientos.length} movimientos encontrados`;

  if (!movimientos.length) {
    const fila = nodo("tr");
    const celda = nodo("td", "rp-vacio", "No hay abonos registrados en este periodo.");
    celda.colSpan = 6;
    fila.append(celda);
    cuerpo.append(fila);
    return;
  }

  for (const pago of movimientos.slice(0, 100)) {
    cuerpo.append(crearFila([
      fechaMostrar(pago.fechaPago),
      pago.clienteNombre || "Sin cliente",
      pago.folioPrestamo || "Sin folio",
      nombreCobrador(pago.creadoPor, pago.cobradorNombre),
      dinero(pago.montoCentavos),
      dinero(pago.saldoPosteriorCentavos)
    ]));
  }
}

function actualizarFiltrosEmpleados() {
  const selector = rp("reportesEmpleado");
  const seleccionado = selector.value;
  selector.replaceChildren(new Option("Todos los cobradores", "todos"));

  const identificadores = new Set(pagos.map(p => p.creadoPor).filter(Boolean));

  for (const usuario of usuarios) {
    if (usuario.rol === "empleado" || usuario.rol === "admin") {
      identificadores.add(usuario.id);
    }
  }

  for (const id of identificadores) {
    const pago = pagos.find(p => p.creadoPor === id);

    selector.add(new Option(
      nombreCobrador(id, pago?.cobradorNombre),
      id
    ));
  }

  selector.value = identificadores.has(seleccionado)
    ? seleccionado
    : "todos";
}

function renderizar() {
  if (!autorizado) return;

  const registros = todosLosSaldos();
  const validos = registros.filter(p => p.completo);
  const incompletos = registros.filter(p => !p.completo);

  const capitalGeneral = registros.reduce(
    (suma, p) => suma + p.capital, 0
  );

  const capitalValido = validos.reduce(
    (suma, p) => suma + p.capital, 0
  );

  const pactado = validos.reduce(
    (suma, p) => suma + p.total, 0
  );

  const recuperado = validos.reduce(
    (suma, p) => suma + p.abonado, 0
  );

  const pendiente = validos.reduce(
    (suma, p) => suma + p.pendiente, 0
  );

  const resumen = rp("reportesResumen");

  resumen.replaceChildren(
    crearTarjeta(
      "Capital entregado",
      capitalGeneral,
      `${registros.length} préstamos registrados`
    ),
    crearTarjeta(
      "Total pactado válido",
      pactado,
      `${validos.length} préstamos con datos completos`
    ),
    crearTarjeta(
      "Total abonado",
      recuperado,
      "Saldos acumulados de préstamos completos"
    ),
    crearTarjeta(
      "Saldo pendiente",
      pendiente,
      "De préstamos con datos completos"
    )
  );

  let aviso = rp("reportesAvisoIncompletos");

  if (!aviso) {
    aviso = document.createElement("div");
    aviso.id = "reportesAvisoIncompletos";
    aviso.style.cssText =
      "background:#fff7e6;border:1px solid #e9d29c;" +
      "color:#78531a;padding:14px;border-radius:11px;" +
      "font-size:12px;line-height:1.7";

    resumen.after(aviso);
  }

  if (incompletos.length) {
    aviso.hidden = false;

    const capitalExcluido = incompletos.reduce(
      (suma, p) => suma + p.capital, 0
    );

    aviso.textContent =
      `${incompletos.length} préstamo(s) requieren revisión. ` +
      `Capital registrado: ${dinero(capitalExcluido)}. ` +
      "Se incluyen en el capital general, pero no en el " +
      "total pactado, rendimiento ni saldo pendiente. " +
      "Revisa sus datos antes de considerarlos en resultados financieros.";
  } else {
    aviso.hidden = true;
  }

  rp("reportesRendimiento").textContent =
    dinero(pactado - capitalValido);

  rp("reportesLiquidados").textContent = validos
    .filter(p => p.total > 0 && p.pendiente === 0).length;

  rp("reportesPendientes").textContent = validos
    .filter(p => p.pendiente > 0).length;

  movimientosVisibles = filtrarMovimientos();

  const cobradoPeriodo = movimientosVisibles.reduce(
    (suma, pago) => suma + centavos(pago.montoCentavos),
    0
  );

  rp("reportesPeriodoTotal").textContent = dinero(cobradoPeriodo);

  rp("reportesPeriodoConteo").textContent =
    `${movimientosVisibles.length} abonos en el periodo seleccionado`;

  dibujarGrafica(movimientosVisibles);
  dibujarEmpleados(movimientosVisibles);
  dibujarMovimientos(movimientosVisibles);

  mostrarEstado(`Datos actualizados: ${fechaLocal()}`);
}

async function cargarDatos() {
  if (!autorizado || cargando) return;

  cargando = true;
  rp("reportesActualizar").disabled = true;
  mostrarEstado("Consultando datos de Firebase...");

  try {
    const [resultadoPrestamos, resultadoPagos, resultadoSaldos, resultadoUsuarios] =
      await Promise.all([
        getDocs(collection(db, "prestamos")),
        getDocs(collection(db, "pagos")),
        getDocs(collection(db, "saldosPrestamo")),
        getDocs(collection(db, "usuarios"))
      ]);

    prestamos = resultadoPrestamos.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    pagos = resultadoPagos.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    saldos = resultadoSaldos.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    usuarios = resultadoUsuarios.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    actualizarFiltrosEmpleados();
    renderizar();
  } catch (error) {
    mostrarEstado("No se pudieron cargar los reportes: " + error.message, true);
  } finally {
    cargando = false;
    rp("reportesActualizar").disabled = false;
  }
}

function exportarCSV() {
  if (!autorizado) return;

  const proteger = valor => {
    let texto = String(valor ?? "");

    if (/^[\s]*[=+\-@\t\r]/.test(texto)) {
      texto = "'" + texto;
    }

    return `"${texto.replace(/"/g, '""')}"`;
  };

  const filas = [
    ["Fecha", "Cliente", "Prestamo", "Cobrador", "Monto MXN", "Saldo posterior MXN", "Medio", "Observaciones"]
  ];

  for (const pago of movimientosVisibles) {
    filas.push([
      pago.fechaPago || "",
      pago.clienteNombre || "",
      pago.folioPrestamo || "",
      nombreCobrador(pago.creadoPor, pago.cobradorNombre),
      (centavos(pago.montoCentavos) / 100).toFixed(2),
      (centavos(pago.saldoPosteriorCentavos) / 100).toFixed(2),
      pago.medio || "",
      pago.nota || ""
    ]);
  }

  const csv = "\uFEFF" + filas.map(f =>
    f.map(proteger).join(",")
  ).join("\r\n");

  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" })
  );

  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `reporte-abonos-${fechaLocal()}.csv`;
  document.body.append(enlace);
  enlace.click();
  enlace.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function establecerPeriodo(tipo) {
  const hoy = fechaLocal();

  if (tipo === "todos") {
    rp("reportesDesde").value = "";
    rp("reportesHasta").value = "";
  } else if (tipo === "hoy") {
    rp("reportesDesde").value = hoy;
    rp("reportesHasta").value = hoy;
  } else {
    const inicio = new Date(`${hoy}T12:00:00Z`);

    if (tipo === "semana") inicio.setUTCDate(inicio.getUTCDate() - 6);
    if (tipo === "mes") inicio.setUTCDate(inicio.getUTCDate() - 29);

    rp("reportesDesde").value = inicio.toISOString().slice(0, 10);
    rp("reportesHasta").value = hoy;
  }

  renderizar();
}

function iniciar() {
  rp("reportesActualizar").addEventListener("click", cargarDatos);
  rp("reportesExportar").addEventListener("click", exportarCSV);
  rp("reportesDesde").addEventListener("change", renderizar);
  rp("reportesHasta").addEventListener("change", renderizar);
  rp("reportesEmpleado").addEventListener("change", renderizar);

  document.querySelectorAll("[data-rp-periodo]").forEach(boton => {
    boton.addEventListener("click", () => {
      establecerPeriodo(boton.dataset.rpPeriodo);
    });
  });
}

iniciar();

onAuthStateChanged(auth, async usuario => {
  autorizado = false;

  if (!usuario) return;

  try {
    const perfil = await getDoc(doc(db, "usuarios", usuario.uid));

    if (
      !perfil.exists() ||
      perfil.data().rol !== "admin" ||
      perfil.data().estado !== "activo"
    ) {
      return;
    }

    autorizado = true;
    await cargarDatos();
  } catch (error) {
    mostrarEstado("No se pudo verificar el acceso: " + error.message, true);
  }
});

