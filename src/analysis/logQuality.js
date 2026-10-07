// ======================================================
// BLACKBOX LAB — LOG QUALITY GATE
// ======================================================
//
// Before trusting any analysis, be honest about the
// input: what can THIS log actually tell us? Analysis
// silently done on inadequate data is how a teaching
// tool teaches wrong things.
//
// ======================================================

// A column can exist and still carry nothing: a model flown
// without its RPM wire logs headspeed as constant zero, a dead
// current sensor logs zero amps for the whole flight. A
// capability chip built on mere column presence then promises
// "fully measurable" for an analysis that has nothing to
// measure — so capability flags are computed from this, never
// from Boolean(column).
export function columnCarriesData(values) {
  return (
    Array.isArray(values) &&
    values.some(
      (value) => Number.isFinite(value) && value !== 0
    )
  );
}

export function assessLogQuality({
  sampleRateHz,
  durationSeconds,
  corruptFrames = 0,
  totalFrames = 0,
  hasUnfilteredGyro,
  hasFilteredGyro,
  hasHeadspeed,
  hasGovernorTarget,
  hasVbat,
  hasAmperage,
  hasRssi = false,
  hasLinkFlags = false,
  hasVbec = false
}) {
  const capabilities = [];
  const warnings = [];

  // ---- vibration & filters need sample rate + gyro ----
  const anyGyro = hasUnfilteredGyro || hasFilteredGyro;

  if (!anyGyro) {
    capabilities.push({
      name: "Vibration & filters",
      level: "missing",
      note: "Keine Gyro-Daten in diesem Log."
    });
  } else if (!sampleRateHz || sampleRateHz < 400) {
    capabilities.push({
      name: "Vibration & filters",
      level: "partial",
      note: `Log-Rate ~${Math.round(sampleRateHz || 0)} Hz ist zu langsam für Heck-Frequenz-Vibration. Erhöhe die Blackbox-Rate für das vollständige Bild.`
    });
  } else if (sampleRateHz < 1000) {
    capabilities.push({
      name: "Vibration & filters",
      level: "partial",
      note: `Log-Rate ~${Math.round(sampleRateHz)} Hz erfasst Hauptrotor- und Heckvibration; nur sehr hohe Motor-/Lagerfrequenzen liegen außerhalb des Sichtbereichs.`
    });
  } else if (!hasUnfilteredGyro) {
    capabilities.push({
      name: "Vibration & filters",
      level: "partial",
      note: "Nur gefilterter Gyro wird geloggt: Rauschen ist nach der Filterung sichtbar, deshalb wird echte Vibration unterschätzt und Filterwirkung lässt sich nicht messen. Aktiviere ungefilterte Gyro-Protokollierung (gyro_raw) für das vollständige Bild."
    });
  } else {
    capabilities.push({
      name: "Vibration & filters",
      level: "full",
      note:
        hasFilteredGyro
          ? "Ungefilterter + gefilterter Gyro mit gesunder Rate: vollständige Rausch- und Filterwirkungs-Analyse."
          : "Ungefilterter Gyro mit gesunder Rate. Wenn auch der gefilterte Gyro geloggt wird, kann der Filter-Berater die echte Wirkung deiner Filter messen."
    });
  }

  // ---- governor ----
  if (hasHeadspeed && hasGovernorTarget) {
    capabilities.push({
      name: "Governor",
      level: "full",
      note: "Headspeed und Ziel vorhanden: Droop und Nachführung vollständig messbar."
    });
  } else if (hasHeadspeed) {
    capabilities.push({
      name: "Governor",
      level: "partial",
      note: "Headspeed wird geloggt, aber kein Governor-Ziel: Stabilität ist sichtbar, Droop gegen Ziel nicht."
    });
  } else {
    capabilities.push({
      name: "Governor",
      level: "missing",
      note: "Keine Headspeed in diesem Log. Aktiviere RPM-Telemetrie, um die Governor-Analyse freizuschalten."
    });
  }

  // ---- power ----
  if (hasVbat && hasAmperage) {
    capabilities.push({
      name: "Battery & ESC",
      level: "full",
      note: "Spannung und Strom vorhanden: Einbruch, Verbrauch und Widerstandsschätzungen verfügbar."
    });
  } else if (hasVbat) {
    capabilities.push({
      name: "Battery & ESC",
      level: "partial",
      note: "Nur Spannung: Einbruch ist sichtbar; Verbrauch und Innenwiderstand brauchen einen Stromsensor."
    });
  } else {
    capabilities.push({
      name: "Battery & ESC",
      level: "missing",
      note: "Keine elektrische Telemetrie in diesem Log."
    });
  }

  // ---- signal & link ----
  if (hasRssi) {
    capabilities.push({
      name: "Signal & link",
      level: "full",
      note: "Signalstärke und Empfänger-Flags vorhanden: Verbindungsqualität vollständig messbar."
    });
  } else if (hasLinkFlags) {
    capabilities.push({
      name: "Signal & link",
      level: "partial",
      note: "Nur Empfänger-Flags: Failsafe- und Signal-valid-Zustand sind sichtbar, aber keine Signalstärke-Kurve wurde geloggt."
    });
  } else {
    capabilities.push({
      name: "Signal & link",
      level: "missing",
      note: "Keine Link-Telemetrie in diesem Log. Aktiviere RSSI-Telemetrie für Signalanalyse."
    });
  }

  // ---- receiver power ----
  if (hasVbec) {
    capabilities.push({
      name: "BEC output",
      level: "full",
      note: "BEC-Spannung vorhanden: Empfänger-Spannungsstabilität, Einbrüche und ihr Servo-Zusammenhang sind messbar."
    });
  } else {
    capabilities.push({
      name: "BEC output",
      level: "missing",
      note: "Keine BEC-Spannung in diesem Log. Aktiviere BEC-Spannungs-Telemetrie für Empfänger-Spannungsanalyse."
    });
  }

  // ---- general warnings ----
  if (durationSeconds && durationSeconds < 20) {
    warnings.push(
      `Kurzer Flug (${durationSeconds.toFixed(0)} s): Trends und Mittelwerte sind weniger verlässlich; Punktzahlen als Richtwerte verstehen.`
    );
  }

  if (totalFrames > 0 && corruptFrames / totalFrames > 0.02) {
    warnings.push(
      `${((corruptFrames / totalFrames) * 100).toFixed(1)} % der Frames waren korrupt und wurden übersprungen. Erwäge einen schnelleren/besseren Flash- oder SD-Speicher.`
    );
  }

  const missing = capabilities.filter((c) => c.level === "missing").length;
  const partial = capabilities.filter((c) => c.level === "partial").length;

  // The chips speak about DATA, not about conclusions — the
  // analyses rate their own confidence from what they measure.
  const summary =
    missing === 0 && partial === 0 && warnings.length === 0
      ? "Dieses Log ist ausgezeichnet: jede Analyse hat die Daten, die sie braucht."
      : missing === 0
        ? "Gutes Log: Ein paar Analysen laufen mit reduzierter Sicherheit (Details unten)."
        : "Dieses Log schränkt einige Analysen ein: Die Hinweise unten sagen, was zu aktivieren ist für das vollständige Bild.";

  return { capabilities, warnings, summary };
}
