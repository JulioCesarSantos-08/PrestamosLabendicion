
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const seg = id => document.getElementById(id);

const formatoSeguimiento = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

let sesionSeguimiento = 0;
let cancelarPrestamos = null;
let cancelarSaldos = [];
let prestamosSeguimiento = [];
let saldosSeguimiento = new Map();
let erroresSeguimiento = new Set();

function dineroSeguimiento(valor) {
  return formatoSeguimiento.format((Number(valor) || 0) / 100);
}

function fechaHoySeguimiento() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const obtener = tipo => partes.find(parte => parte.type === tipo)?.value;

  return `${obtener("year")}-${obtener("month")}-${obtener("day")}`;
}

function fechaValidaSeguimiento(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor || "")) return false;
  const fecha = new Date(`${valor}T12:00:00Z`);
  return Number.isFinite(fecha.getTime())
    && fecha.toISOString().slice(0, 10) === valor;
}

function sumarDiasSeguimiento(valor, dias) {
  if (!fechaValidaSeguimiento(valor)) return null;
  const fecha = new Date(`${valor}T12:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

function diferenciaDiasSeguimiento(inicio, fin) {
  if (!fechaValidaSeguimiento(inicio) || !fechaValidaSeguimiento(fin)) {
    return null;
  }

  return Math.round((
    Date.parse(`${fin}T12:00:00Z`) -
    Date.parse(`${inicio}T12:00:00Z`)
  ) / 86400000);
}

function elementoSeguimiento(tipo, clase = "", texto = "") {
  const elemento = document.createElement(tipo);
  elemento.className = clase;
  elemento.textContent = texto;
  return elemento;
}

function evaluarPrestamo(prestamo, saldo, hoy) {
  const total = prestamo.totalPactadoCentavos;
  const abono = prestamo.abonoCentavos;
  const intervalo = prestamo.intervaloDias;
  const numero = prestamo.numeroPagos;

  if (
    !Number.isSafeInteger(total) || total <= 0 ||
    !Number.isSafeInteger(abono) || abono <= 0 ||
    !Number.isInteger(intervalo) || intervalo < 1 ||
    !Number.isInteger(numero) || numero < 1 ||
    !fechaValidaSeguimiento(prestamo.primeraFecha) ||
    !fechaValidaSeguimiento(prestamo.fechaFin)
  ) {
    return { estado: "incompleto", prestamo };
  }

  if (saldo === undefined) {
    return { estado: "consultando", prestamo };
  }

  if (saldo === null && erroresSeguimiento.has(prestamo.id)) {
    return { estado: "error", prestamo };
  }

  const pagado = saldo
    ? saldo.abonadoCentavos
    : 0;

  if (
    !Number.isSafeInteger(pagado) ||
    pagado < 0 ||
    pagado > total
  ) {
    return { estado: "error", prestamo };
  }

  if (pagado >= total) {
    return { estado: "liquidado", prestamo, pagado, total };
  }

  const diferencia = diferenciaDiasSeguimiento(
    prestamo.primeraFecha,
    hoy
  );

  if (diferencia === null) {
    return { estado: "incompleto", prestamo };
  }

  const vencidas = diferencia <= 0
    ? 0
    : Math.min(
      numero,
      Math.floor((diferencia - 1) / intervalo) + 1
    );

  const comprometido = Math.min(
    total,
    vencidas * abono
  );

  const atraso = Math.max(0, comprometido - pagado);

  const siguienteNumero = vencidas + 1;
  const proximaFecha = siguienteNumero <= numero
    ? sumarDiasSeguimiento(
      prestamo.primeraFecha,
      (siguienteNumero - 1) * intervalo
    )
    : null;

  return {
    estado: atraso > 0 ? "atrasado" : "alCorriente",
    prestamo,
    pagado,
    total,
    vencidas,
    comprometido,
    atraso,
    proximaFecha
  };
}

function renderizarSeguimiento() {
  const contenedor = seg("seguimientoLista");
  const resumen = seg("seguimientoResumen");

  if (!contenedor || !resumen) return;

  contenedor.replaceChildren();

  const hoy = fechaHoySeguimiento();
  const resultados = prestamosSeguimiento.map(prestamo =>
    evaluarPrestamo(prestamo, saldosSeguimiento.get(prestamo.id), hoy)
  );

  const atrasados = resultados
    .filter(item => item.estado === "atrasado")
    .sort((a, b) => b.atraso - a.atraso);

  const alCorriente = resultados.filter(
    item => item.estado === "alCorriente"
  ).length;

  const liquidados = resultados.filter(
    item => item.estado === "liquidado"
  ).length;

  const sinVerificar = resultados.filter(
    item => ["consultando", "error", "incompleto"].includes(item.estado)
  ).length;

  const totalAtrasado = atrasados.reduce(
    (suma, item) => suma + item.atraso,
    0
  );

  resumen.replaceChildren();

  const indicadores = [
    ["Atraso estimado", dineroSeguimiento(totalAtrasado)],
    ["Préstamos con atraso", String(atrasados.length)],
    ["Al corriente", String(alCorriente)],
    ["Liquidados", String(liquidados)]
  ];

  for (const [etiqueta, valor] of indicadores) {
    const tarjeta = elementoSeguimiento("div", "seg-indicador");
    tarjeta.append(
      elementoSeguimiento("span", "", etiqueta),
      elementoSeguimiento("strong", "", valor)
    );
    resumen.append(tarjeta);
  }

  if (!prestamosSeguimiento.length) {
    contenedor.append(elementoSeguimiento(
      "p",
      "seg-vacio",
      "No tienes préstamos asignados."
    ));
  } else if (!atrasados.length) {
    contenedor.append(elementoSeguimiento(
      "p",
      "seg-vacio",
      sinVerificar
        ? "No se detectaron atrasos entre los préstamos verificados."
        : "No se detectan atrasos según los abonos registrados."
    ));
  }

  for (const item of atrasados) {
    const tarjeta = elementoSeguimiento("article", "seg-cliente");
    const encabezado = elementoSeguimiento("div", "seg-encabezado");

    encabezado.append(
      elementoSeguimiento(
        "strong",
        "",
        item.prestamo.clienteNombre || "CLIENTE"
      ),
      elementoSeguimiento(
        "span",
        "seg-etiqueta",
        "SEGUIMIENTO"
      )
    );

    tarjeta.append(
      encabezado,
      elementoSeguimiento(
        "p",
        "",
        `Préstamo: ${item.prestamo.folio || item.prestamo.id}`
      )
    );

    const cifras = elementoSeguimiento("div", "seg-cifras");

    const vencido = elementoSeguimiento("div");
    vencido.append(
      elementoSeguimiento("span", "", "Atraso estimado"),
      elementoSeguimiento(
        "strong",
        "seg-alerta",
        dineroSeguimiento(item.atraso)
      )
    );

    const recibido = elementoSeguimiento("div");
    recibido.append(
      elementoSeguimiento("span", "", "Total recibido"),
      elementoSeguimiento(
        "strong",
        "",
        dineroSeguimiento(item.pagado)
      )
    );

    cifras.append(vencido, recibido);
    tarjeta.append(cifras);

    tarjeta.append(elementoSeguimiento(
      "p",
      "seg-detalle",
      `${item.vencidas} cuota(s) con fecha vencida. ` +
      `Debió cubrir: ${dineroSeguimiento(item.comprometido)}.`
    ));

    contenedor.append(tarjeta);
  }

  seg("seguimientoAviso").textContent = sinVerificar
    ? `${sinVerificar} préstamo(s) todavía no se pudieron verificar. ` +
      "No se consideran al corriente automáticamente."
    : "Cálculo orientativo según fechas pactadas y abonos acumulados. " +
      "No representa por sí solo una mora confirmada ni cargos adicionales.";
}

function limpiarSeguimiento() {
  if (cancelarPrestamos) {
    cancelarPrestamos();
    cancelarPrestamos = null;
  }

  for (const cancelar of cancelarSaldos) {
    cancelar();
  }

  cancelarSaldos = [];
  prestamosSeguimiento = [];
  saldosSeguimiento = new Map();
  erroresSeguimiento = new Set();
}

function cargarSaldosSeguimiento(prestamos, version) {
  for (const cancelar of cancelarSaldos) cancelar();

  cancelarSaldos = [];
  saldosSeguimiento = new Map();
  erroresSeguimiento = new Set();

  for (const prestamo of prestamos) {
    const cancelar = onSnapshot(
      doc(db, "saldosPrestamo", prestamo.id),
      resultado => {
        if (version !== sesionSeguimiento) return;

        saldosSeguimiento.set(
          prestamo.id,
          resultado.exists() ? resultado.data() : null
        );

        renderizarSeguimiento();
      },
      () => {
        if (version !== sesionSeguimiento) return;

        erroresSeguimiento.add(prestamo.id);
        saldosSeguimiento.set(prestamo.id, null);
        renderizarSeguimiento();
      }
    );

    cancelarSaldos.push(cancelar);
  }

  renderizarSeguimiento();
}

function iniciarSeguimiento() {
  const seccion = seg("homeSection");

  if (!seccion) return;

  const panel = elementoSeguimiento("section", "seg-panel");
  panel.innerHTML = `
    <div class="seg-titulo">
      <div>
        <span class="seg-subtitulo">SEGUIMIENTO DE CARTERA</span>
        <h2>Atrasos estimados</h2>
        <p>Comparación entre calendario y abonos registrados.</p>
      </div>
    </div>
    <div id="seguimientoResumen" class="seg-resumen"></div>
    <div id="seguimientoLista" class="seg-lista"></div>
    <p id="seguimientoAviso" class="seg-nota"></p>
  `;

  seccion.append(panel);
  renderizarSeguimiento();
}

iniciarSeguimiento();

onAuthStateChanged(auth, async usuario => {
  sesionSeguimiento++;
  const version = sesionSeguimiento;
  limpiarSeguimiento();
  renderizarSeguimiento();

  if (!usuario) return;

  try {
    const perfil = await getDoc(doc(db, "usuarios", usuario.uid));

    if (version !== sesionSeguimiento) return;

    if (
      !perfil.exists() ||
      perfil.data().rol !== "empleado" ||
      perfil.data().estado !== "activo"
    ) {
      return;
    }

    const consulta = query(
      collection(db, "prestamos"),
      where("empleadoId", "==", usuario.uid)
    );

    cancelarPrestamos = onSnapshot(
      consulta,
      resultado => {
        if (version !== sesionSeguimiento) return;

        prestamosSeguimiento = resultado.docs.map(item => ({
          id: item.id,
          ...item.data()
        }));

        cargarSaldosSeguimiento(prestamosSeguimiento, version);
      },
      () => {
        seg("seguimientoAviso").textContent =
          "No fue posible consultar los préstamos asignados.";
      }
    );
  } catch {
    seg("seguimientoAviso").textContent =
      "No se pudo comprobar el acceso del empleado.";
  }
});
