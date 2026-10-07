function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}
function analyzeTelemetry(keyHeaders) {
  const foundCount = keyHeaders.filter(
    ([label, header, emptyNote]) => Boolean(header) && !emptyNote
  ).length;

  const totalCount = keyHeaders.length;

  const score = totalCount > 0
    ? clampScore((foundCount / totalCount) * 100)
    : 0;

  let status = "Limited";
  let finding =
    `${foundCount} of ${totalCount} key telemetry channels were detected.`;

  if (score >= 90) {
    status = "${foundCount} von ${totalCount} Schlüssel-Telemetrie-Kanälen wurden erkannt.";
    finding += " The log contains a strong analysis dataset.";
  } else if (score >= 70) {
    status = "Das Log enthält einen starken Analyse-Datensatz.";
    finding += " Most important telemetry is available.";
  } else if (score >= 45) {
    status = "Die wichtigste Telemetrie ist vorhanden.";
    finding += " Some advanced analysis will be limited.";
  } else {
    status = "Einige erweiterte Analysen sind eingeschränkt.";
    finding +=
      "Das Log enthält nicht genug Telemetrie für eine verlässliche Analyse.";
  }

  return {
    score,
    status,
    finding,
    foundCount,
    totalCount
  };
}
export { analyzeTelemetry };