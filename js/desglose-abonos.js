export function repartoAcumulado(capitalCentavos, totalPactadoCentavos, abonadoCentavos) {
  const capital = Number(capitalCentavos) || 0;
  const total = Number(totalPactadoCentavos) || 0;
  const abonado = Number(abonadoCentavos) || 0;

  if (!Number.isFinite(capital) || !Number.isFinite(total) || !Number.isFinite(abonado)) {
    return null;
  }

  if (capital < 0 || total <= 0 || total < capital || abonado < 0 || abonado > total) {
    return null;
  }

  const capitalRecuperado = Number(
    (BigInt(Math.round(abonado)) * BigInt(Math.round(capital)) + BigInt(Math.round(total)) / 2n) /
    BigInt(Math.round(total))
  );

  const interesesCobrados = abonado - capitalRecuperado;

  return {
    capitalRecuperado,
    interesesCobrados,
    capitalPendiente: capital - capitalRecuperado,
    interesesPendientes: total - capital - interesesCobrados,
    saldoPendiente: total - abonado
  };
}

export function repartoMovimiento(capitalCentavos, totalPactadoCentavos, montoCentavos, saldoPosteriorCentavos) {
  const total = Number(totalPactadoCentavos) || 0;
  const monto = Number(montoCentavos) || 0;
  const saldoPosterior = Number(saldoPosteriorCentavos);

  if (!Number.isFinite(total) || !Number.isFinite(monto) || !Number.isFinite(saldoPosterior)) {
    return null;
  }

  const acumuladoDespues = total - saldoPosterior;
  const acumuladoAntes = acumuladoDespues - monto;

  const antes = repartoAcumulado(capitalCentavos, totalPactadoCentavos, acumuladoAntes);
  const despues = repartoAcumulado(capitalCentavos, totalPactadoCentavos, acumuladoDespues);

  if (!antes || !despues) return null;

  return {
    aCapitalCentavos: despues.capitalRecuperado - antes.capitalRecuperado,
    aInteresesCentavos: despues.interesesCobrados - antes.interesesCobrados,
    capitalRecuperadoTotalCentavos: despues.capitalRecuperado,
    interesesCobradosTotalCentavos: despues.interesesCobrados,
    capitalPendienteCentavos: despues.capitalPendiente,
    interesesPendientesCentavos: despues.interesesPendientes,
    abonadoAcumuladoCentavos: acumuladoDespues,
    saldoPendienteCentavos: despues.saldoPendiente
  };
}
