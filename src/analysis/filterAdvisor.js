// ======================================================
// BLACKBOX LAB — FILTER ADVISOR
// ======================================================
//
// Rotorflight's superpower is rotor-speed-linked filtering
// (harmonic notches that follow headspeed). This advisor
// closes the loop the spectrum opens:
//
//   1. find the vibration peaks (unfiltered gyro)
//   2. name their mechanical source via rotor harmonics
//   3. MEASURE how much of each peak the current filters
//      remove (unfiltered vs filtered gyro)
//   4. recommend, in plain language, what to change
//
// It never silently changes anything — it explains and points.
//
// ======================================================

import { VIBRATION_FLOOR_HZ } from "./dsp/fft.js";

function findPeaks(spectrum, minimumHz = VIBRATION_FLOOR_HZ, count = 5) {
  const { frequencies, magnitudes } = spectrum;
  const peaks = [];

  for (let i = 2; i < frequencies.length - 2; i += 1) {
    if (
      frequencies[i] >= minimumHz &&
      magnitudes[i] > magnitudes[i - 1] &&
      magnitudes[i] > magnitudes[i + 1] &&
      magnitudes[i] > 1
    ) {
      const nearbyMagnitudes = [];

for (
  let nearbyIndex = Math.max(0, i - 8);
  nearbyIndex <= Math.min(magnitudes.length - 1, i + 8);
  nearbyIndex += 1
) {
  if (Math.abs(nearbyIndex - i) <= 1) {
    continue;
  }

  const nearbyMagnitude =
    magnitudes[nearbyIndex];

  if (Number.isFinite(nearbyMagnitude)) {
    nearbyMagnitudes.push(
      nearbyMagnitude
    );
  }
}

const localNoiseFloor =
  nearbyMagnitudes.length > 0
    ? nearbyMagnitudes.reduce(
        (sum, value) => sum + value,
        0
      ) / nearbyMagnitudes.length
    : 0;

const prominenceRatio =
  localNoiseFloor > 0 &&
  Number.isFinite(magnitudes[i])
    ? magnitudes[i] / localNoiseFloor
    : null;

peaks.push({
  hz: frequencies[i],
  magnitude: magnitudes[i],
  bin: i,
  localNoiseFloor,
  prominenceRatio
});
    }
  }

  peaks.sort((a, b) => b.magnitude - a.magnitude);

  const distinct = [];

  for (const peak of peaks) {
    if (distinct.every((other) => Math.abs(other.hz - peak.hz) > 6)) {
      distinct.push(peak);
    }

    if (distinct.length === count) {
      break;
    }
  }

  return distinct;
}

function classifySource(peakHz, headspeedRpm) {
  if (!headspeedRpm || headspeedRpm < 300) {
    return { source: "unbekannt (keine Headspeed geloggt)", rpmLinked: false };
  }

  const oneRev = headspeedRpm / 60;
  const ratio = peakHz / oneRev;

  if (Math.abs(ratio - 1) < 0.15) {
    return { source: "Hauptrotor 1/rev", rpmLinked: true };
  }

  if (Math.abs(ratio - 2) < 0.2) {
    return { source: "Hauptrotor 2/rev", rpmLinked: true };
  }

  if (Math.abs(ratio - 3) < 0.25) {
    return { source: "Hauptrotor 3/rev", rpmLinked: true };
  }

  if (ratio > 3.5 && ratio < 6.5) {
    return {
      source: `Heckbereich (~${ratio.toFixed(1)}× Rotordrehzahl)`,
      rpmLinked: true
    };
  }

  if (ratio >= 6.5) {
    return {
      source: `hohe Frequenz (~${ratio.toFixed(1)}× Rotordrehzahl): Motor-/Lagergebiet`,
      rpmLinked: ratio < 15
    };
  }

  return { source: "nicht rotorgebunden (elektrisch oder Rahmenresonanz)", rpmLinked: false };
}

export function magnitudeNear(spectrum, hz) {
  const { frequencies, magnitudes } = spectrum;
  let best = 0;

  for (let i = 0; i < frequencies.length; i += 1) {
    if (Math.abs(frequencies[i] - hz) <= 3 && magnitudes[i] > best) {
      best = magnitudes[i];
    }
  }

  return best;
}

export function adviseFilters({
  unfilteredSpectrum,
  filteredSpectrum,
  headspeedRpm
}) {
  if (!unfilteredSpectrum) {
    return null;
  }

  const peaks = findPeaks(unfilteredSpectrum);

  if (peaks.length === 0) {
    return {
      story:
        "Keine nennenswerten Vibrationsspitzen im UNGEFILTERTEN Gyro gefunden: Das Rohsignal ist so sauber, wie es nur geht. Egal, wie deine Filter eingestellt sind, sie werden nicht gefordert.",
      rows: [],
      recommendations: [],
      filteredSpectrum: filteredSpectrum ?? null
    };
  }

  const rows = peaks.map((peak) => {
    const classified = classifySource(peak.hz, headspeedRpm);
    const filteredMagnitude = filteredSpectrum
      ? magnitudeNear(filteredSpectrum, peak.hz)
      : null;

    const reductionPercent =
      filteredMagnitude !== null && peak.magnitude > 0
        ? Math.max(
            0,
            Math.min(100, (1 - filteredMagnitude / peak.magnitude) * 100)
          )
        : null;

    return {
      hz: Math.round(peak.hz * 10) / 10,
      magnitude: Math.round(peak.magnitude * 10) / 10,
      source: classified.source,
      rpmLinked: classified.rpmLinked,
      // Below ~20 Hz the flight controller itself must respond, so
      // no gyro filter may act there without costing control phase.
      // Whatever the source, a peak this low is a bench story.
      belowFilterBand: peak.hz < 20,
      prominenceRatio: peak.prominenceRatio,
      filteredMagnitude:
        filteredMagnitude !== null
          ? Math.round(filteredMagnitude * 10) / 10
          : null,
      reductionPercent:
        reductionPercent !== null ? Math.round(reductionPercent) : null
    };
  });

  const recommendations = [];
const biggest = rows[0];
const isStrongProminentPeak =
  Number.isFinite(
    biggest?.prominenceRatio
  ) &&
  biggest.prominenceRatio >= 20;




// ---- below the filter band: bench only ----
// A peak under ~20 Hz sits inside the band the flight controller
// must react to. A notch or a lower cutoff there costs control
// response and cannot fix the shake — so this advice always points
// at the airframe, never at filter settings.
const structuralRows = rows.filter(
  (row) => row.belowFilterBand && row.magnitude > 3
);

if (structuralRows.length > 0) {
  const strongest = structuralRows[0];

  recommendations.push({
    priority: "first",
    text: `Deine ${strongest.hz}-Hz-Spitze (Betrag ${strongest.magnitude}) liegt unter ~20 Hz, innerhalb des Bandes, in dem die Flugsteuerung selbst arbeitet. Kein Gyro-Filter kann sie entfernen, ohne die Steuerantwort aufzuweichen, füge für diese also keinen Notch hinzu und senke keine Grenzfrequenz. Das ist eine mechanische Geschichte: Rahmen- und Auslegersteifigkeit, Fahrwerks- oder Haubenresonanz, Befestigung und Dämpfung sind die Stellen, an denen man suchen sollte.`
  });
}

// ---- mechanics before filters ----
// A prominent peak that the filters demonstrably contain (strong
// measured reduction, quiet residual) is an observation to monitor,
// not a mechanical alarm — the frequency match names a source
// TERRITORY, it does not diagnose a failed part. Mechanics-first
// wording is reserved for peaks the filters are not containing.
if (isStrongProminentPeak && !biggest.belowFilterBand) {
  const biggestIsManaged =
    Number.isFinite(biggest.reductionPercent) &&
    biggest.reductionPercent >= 90 &&
    Number.isFinite(biggest.filteredMagnitude) &&
    biggest.filteredMagnitude < 1.5;

  recommendations.push({
    priority: biggestIsManaged ? "gentle" : "first",
    text: biggestIsManaged
      ? `Deine größte Spitze (${biggest.magnitude} bei ${biggest.hz} Hz, ${biggest.source}) ist im rohen Gyro auffällig, aber die Filter halten sie im Griff: ${biggest.reductionPercent} % entfernt, ${biggest.filteredMagnitude} verbleiben. Vibration ist vorhanden und wird erfolgreich beherrscht. Keine Änderung empfohlen. Die physische Vibration existiert weiterhin in der Zelle, behalte also den Trend dieser Spitze über die Flüge im Auge und prüfe mechanisch, wenn sie wächst.`
      : `Deine größte Spitze (${biggest.magnitude} bei ${biggest.hz} Hz, ${biggest.source}) ist im Vergleich zu ihrem nahen Rauschpegel sehr auffällig. Prüfe zuerst die Mechanik: Blattwucht und Spurlauf, Kopfdämpfung, Lager, Wellen und Befestigung. Logge dann erneut, bevor du Filter-Einstellungen änderst. Filter können unterdrücken, was der Gyro sieht, aber sie entfernen die physische Vibration nicht aus der Zelle.`
  });
}


// ---- rpm-linked peaks → Rotorflight's rpm filter ----
const rpmLinkedRows = rows.filter(
  (row) =>
    row.rpmLinked &&
    !row.belowFilterBand &&
    row.magnitude > 2
);
  

  if (rpmLinkedRows.length > 0 && headspeedRpm) {
    const list = rpmLinkedRows
      .map((row) => `${row.hz} Hz (${row.source})`)
      .join(", ");

    recommendations.push({
      priority: "filters",
      text: `Diese Spitzen folgen der Rotordrehzahl: ${list}. Genau dafür ist Rotorflights RPM-Filter da (harmonische Notches, an die Headspeed gekoppelt). Er verfolgt die Spitzen, wenn sich die Headspeed ändert, während ein statischer Notch breit (und langsam) sein müsste, um sie weiter abzudecken. Prüfe, dass der RPM-Filter aktiviert ist und diese Harmonischen auf der Filterseite des Configurators abdeckt.`
    });
  }

  // ---- poorly-attenuated peaks ----
  // Peaks below the filter band are excluded: filters not removing
  // what filters must not touch is correct behavior, not a leak.
  const leakyRows = rows.filter(
    (row) =>
      row.reductionPercent !== null &&
      row.reductionPercent < 70 &&
      row.magnitude > 3 &&
      !row.belowFilterBand
  );

  if (leakyRows.length > 0) {
    const list = leakyRows
      .map(
        (row) =>
          `${row.hz} Hz (nur ${row.reductionPercent} % entfernt, ${row.magnitude} → ${row.filteredMagnitude})`
      )
      .join("; ");

    recommendations.push({
      priority: "filters",
      text: `Deine aktuellen Filter lassen einen bedeutenden Anteil dieser Spitzen zur Flugsteuerung durch: ${list}. Wenn die Mechanik schon so gut ist, wie sie sein kann, ist das die Stelle, an der sich ein gezielter Notch lohnt.`
    });
  }

  // ---- strong attenuation of detected peaks ----
const allDetectedPeaksStronglyAttenuated =
  rows.length > 0 &&
  rows.every(
    (row) =>
      Number.isFinite(row.reductionPercent) &&
      row.reductionPercent > 95
  ) &&
  biggest.magnitude < 5;

if (
  allDetectedPeaksStronglyAttenuated &&
  filteredSpectrum
) {
  recommendations.push({
    priority: "gentle",
    text:
      "Die hier erkannten isolierten Vibrationsspitzen werden stark gedämpft, und die rohen Spitzenwerte sind bescheiden. Das bestätigt eine wirksame Unterdrückung dieser bestimmten Frequenzen, beweist aber für sich allein nicht, dass das gesamte Filter-Setup übertrieben ist. Prüfe die breiteren Gyro-Mittelwerte, die Nachführung und die PID-Belege, bevor du Filter-Grenzfrequenzen änderst."
  });
}

  if (recommendations.length === 0) {
    recommendations.push({
      priority: "gentle",
      text: "Die Spitzen sind bescheiden und die Filter beherrschen sie: keine Änderungen vorgeschlagen. Behalte dieses Log als Basis für künftige Vergleiche."
    });
  }

  const story = filteredSpectrum
  ? `${rows.length} Vibrationsspitze(n) gefunden. Die Tabelle zeigt die wahrscheinliche Quelle jeder Spitze und wie stark genau diese Frequenzspitze nach der Filterung reduziert ist. Das heißt nicht, dass die Gesamtvibration des Helis um denselben Prozentsatz reduziert ist.`
  : `${rows.length} Vibrationsspitze(n) im ungefilterten Gyro gefunden. Dieses Log enthält die gefilterte Gyro-Kurve nicht, deshalb lässt sich die Filterwirkung nicht messen.`;

  return {
    story,
    rows,
    recommendations,
    filteredSpectrum: filteredSpectrum ?? null
  };
}
