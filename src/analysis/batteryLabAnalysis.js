// ======================================================
// BLACKBOX LAB — BATTERY LAB ANALYSIS
// ======================================================
//
// Charts may show the complete recording.
//
// Battery conclusions use only stable governed-flight
// samples. Spool-up, spool-down, ground operation and
// headspeed-profile transitions are excluded.
//
// Electrical values remain estimates because telemetry
// scaling and calibration vary between installations.
//
// ======================================================

import {
  detectStableFlightPhase,
  detectInFlightSamples
} from "./flightPhase.js";

function averageOf(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  let sum = 0;

  for (const value of values) {
    sum += value;
  }

  return sum / values.length;
}

function minimumOf(values) {
  let minimum = Infinity;

  for (const value of values) {
    if (Number.isFinite(value) && value < minimum) {
      minimum = value;
    }
  }

  return Number.isFinite(minimum) ? minimum : null;
}
function hasUsablePositiveData(values) {
  if (!Array.isArray(values) || values.length < 200) {
    return false;
  }

  let usableCount = 0;

  for (const value of values) {
    const numericValue = Number(value);

    if (Number.isFinite(numericValue) && numericValue > 0) {
      usableCount += 1;

      if (usableCount >= 20) {
        return true;
      }
    }
  }

  return false;
}
// Raw average of a voltage column — no unit inference here. The
// cross-check below compares sources scale-invariantly, because
// unit inference is exactly what cannot be trusted at this point
// (a 2S micro's decivolt vbat averages 76 raw, which the magnitude
// rule reads as 76 V and would turn into a phantom conflict).
function rawAverage(values) {
  if (!Array.isArray(values)) {
    return null;
  }

  let sum = 0;
  let count = 0;

  for (const value of values) {
    const numericValue = Number(value);

    if (Number.isFinite(numericValue) && numericValue > 0) {
      sum += numericValue;
      count += 1;
    }
  }

  return count > 0 ? sum / count : null;
}

// Scale-free disagreement between two positive readings: fold
// their ratio by powers of ten into [1/√10, √10) and measure the
// distance from 1. Two sources measuring the same pack in ANY
// units (volts, decivolts, centivolts) fold to ~1; a genuine
// reading difference survives every power-of-ten alignment.
// (Folding, not mantissas: 9.8 V vs 10.2 V sit on either side of a
// decade boundary and must still read as agreement.)
function scaleFreeDisagreement(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return null;
  }

  let ratio = a / b;
  const edge = Math.sqrt(10);

  while (ratio >= edge) ratio /= 10;
  while (ratio < 1 / edge) ratio *= 10;

  return Math.max(ratio, 1 / ratio) - 1;
}

// The Lab's display scale rule — used for the note's numbers only,
// after the scale-free comparison has decided the winner.
function scaledAverageVolts(values) {
  const average = rawAverage(values);

  if (average === null) {
    return null;
  }

  const scale = average > 1000 ? 100 : average > 100 ? 10 : 1;
  return average / scale;
}

/**
 * Choose between the ESC's voltage telemetry and the flight
 * controller's own pack reading.
 *
 * ESC voltage is preferred when it is the only usable source — but
 * when the flight controller ALSO measured the pack, the two must
 * agree. Some ESCs report voltage in units the generic scale rule
 * cannot know, and a cell count estimated from such a reading
 * invents a pack that does not exist. The FC's own ADC is the one
 * the pilot calibrates, so on real disagreement it wins — and the
 * returned note says so, for the story of whichever Lab asked.
 */
export function chooseVoltageSource(escVoltage, vbat) {
  const escUsable = hasUsablePositiveData(escVoltage);
  const vbatUsable = hasUsablePositiveData(vbat);

  if (escUsable && vbatUsable) {
    const disagreement = scaleFreeDisagreement(
      rawAverage(escVoltage),
      rawAverage(vbat)
    );

    if (disagreement !== null && disagreement > 0.08) {
      return {
        selected: vbat,
        note: `Die ESC-Spannungstelemetrie (Messwert ~${scaledAverageVolts(escVoltage)?.toFixed(1)} V) weicht von der Packmessung der Flugsteuerung (~${scaledAverageVolts(vbat)?.toFixed(1)} V) ab. Diese Auswertung nutzt die der Flugsteuerung. Ist die Spannungskalibrierung der FC falsch, behebt eine Korrektur dort beide Messwerte auf einmal.`
      };
    }

    return { selected: escVoltage, note: null };
  }

  return {
    selected: escUsable ? escVoltage : vbat,
    note: null
  };
}

export function analyzeBatteryLab({
  timeSeconds,
  vbat,
  escVoltage,
  amperage,
  escCurrent,
  headspeed,
  governorTarget
}) {
  const { selected: selectedVoltage, note: voltageSourceNote } =
    chooseVoltageSource(escVoltage, vbat);

  const selectedAmperage =
    hasUsablePositiveData(escCurrent)
      ? escCurrent
      : amperage;
   if (
    !Array.isArray(selectedVoltage) ||
    selectedVoltage.length < 200
  ) {
    return null;
  }

    // The governor target refines the stable-phase search but is
    // not part of a battery assessment: pack voltage and current
    // are readable whether or not the model runs a Rotorflight
    // governor. Only the data this Lab reads may bound the count.
    const sampleCount = Math.min(
    timeSeconds?.length ?? 0,
    selectedVoltage.length,
    headspeed?.length ?? 0
  );

  if (sampleCount < 200) {
    return null;
  }

  const alignedTime =
    timeSeconds.slice(0, sampleCount);

    const alignedVbat =
    selectedVoltage.slice(0, sampleCount);

    const alignedAmperage =
    Array.isArray(selectedAmperage)
      ? selectedAmperage.slice(0, sampleCount)
      : null;

  const alignedHeadspeed =
    headspeed.slice(0, sampleCount);

  const alignedTarget =
    Array.isArray(governorTarget)
      ? governorTarget.slice(0, sampleCount)
      : [];

  const rawVoltsAverage = averageOf(alignedVbat);

  const voltsScale =
    rawVoltsAverage > 1000
      ? 100
      : rawVoltsAverage > 100
        ? 10
        : 1;

  const volts = alignedVbat.map(
    (value) => Number(value) / voltsScale
  );

  let maxRawAmperage = 0;

  if (alignedAmperage) {
    for (const value of alignedAmperage) {
      const numericValue = Number(value);

      if (
        Number.isFinite(numericValue) &&
        numericValue > maxRawAmperage
      ) {
        maxRawAmperage = numericValue;
      }
    }
  }

  const ampsScale =
    maxRawAmperage > 500 ? 100 : 1;

  const amps = alignedAmperage
    ? alignedAmperage.map(
        (value) => Number(value) / ampsScale
      )
    : null;

  const flightPhase = detectStableFlightPhase({
    timeSeconds: alignedTime,
    headspeed: alignedHeadspeed,
    governorTarget: alignedTarget
  });

  const stableIndexes =
    flightPhase.stableIndexes ?? [];

  if (stableIndexes.length < 100) {
    return {
      status: "insufficient",
      hasRotorSpeedData: flightPhase.hasRotorSpeedData !== false,
      story:
        flightPhase.hasRotorSpeedData === false
          ? "Dieses Log enthält keine Rotordrehzahl-Daten, deshalb ließ sich kein Abschnitt mit gleichmäßiger Last für eine Akku-Bewertung finden."
          : "Kein stabiler Governor-Flugabschnitt war lang genug für eine verlässliche Akku-Bewertung.",
      metrics: [
        {
          label: "Stabile Samples",
          value: String(stableIndexes.length)
        },
        {
          label: "Akku-Ergebnis",
          value: "Zu wenig Daten aus stabilem Flug"
        }
      ],
      sagPercent: null,
      internalResistance: null,
      endVoltsPerCell: null,
      stableSampleCount: stableIndexes.length
    };
  }

  const stableVolts = stableIndexes
    .map((index) => volts[index])
    .filter(Number.isFinite);

  const firstStableIndexes =
    stableIndexes.slice(
      0,
      Math.min(1000, stableIndexes.length)
    );

  const lastStableIndexes =
    stableIndexes.slice(
      Math.max(0, stableIndexes.length - 1000)
    );

  const startVolts = averageOf(
    firstStableIndexes
      .map((index) => volts[index])
      .filter(Number.isFinite)
  );

  const endVolts = averageOf(
    lastStableIndexes
      .map((index) => volts[index])
      .filter(Number.isFinite)
  );

  const minVolts = minimumOf(stableVolts);

  if (
    !Number.isFinite(startVolts) ||
    !Number.isFinite(endVolts) ||
    !Number.isFinite(minVolts)
  ) {
    return null;
  }

  // Cell count estimate based on the beginning of the
  // valid governed-flight window.
  const cellCount = Math.max(
    1,
    Math.round(startVolts / 4.1)
  );

  const endPerCell =
    endVolts / cellCount;

  // The lowest voltage is read across the whole flight, not
  // only the stable phase. The deepest dips ride the hardest
  // load events, and those events pull the rotor off its
  // plateau — which drops them out of the stable set at
  // exactly the moment the pack is answering for itself.
  const flightMinVolts = (() => {
    const inFlightIndexes = detectInFlightSamples({
      timeSeconds: alignedTime,
      headspeed: alignedHeadspeed
    });

    if (!inFlightIndexes) {
      return minVolts;
    }

    let lowest = Infinity;
    let counted = 0;

    for (const index of inFlightIndexes) {
      const value = volts[index];

      if (Number.isFinite(value) && value > 0) {
        counted += 1;

        if (value < lowest) {
          lowest = value;
        }
      }
    }

    return counted >= 100 && lowest < Infinity
      ? Math.min(lowest, minVolts)
      : minVolts;
  })();

  const minimumPerCell =
    flightMinVolts / cellCount;

  // A pack that reads fractionally higher at the end (recovery
  // after the last load, sensor ripple) has zero net drop — a
  // negative "sag" is not a measurement, and it confuses every
  // comparison built on it.
  const flightVoltageDropPercent = Math.max(
    0,
    ((startVolts - endVolts) / startVolts) * 100
  );

  // ---- consumed capacity during stable flight only ----
  let consumedMah = null;

  if (
    amps &&
    amps.length === alignedTime.length
  ) {
    let ampSeconds = 0;

    for (
      let stablePosition = 1;
      stablePosition < stableIndexes.length;
      stablePosition += 1
    ) {
      const previousIndex =
        stableIndexes[stablePosition - 1];

      const currentIndex =
        stableIndexes[stablePosition];

      // Do not integrate across gaps between separate
      // stable-flight segments.
      if (currentIndex !== previousIndex + 1) {
        continue;
      }

      const dt =
        alignedTime[currentIndex] -
        alignedTime[previousIndex];

      const currentAmps =
        Number(amps[currentIndex]);

      const previousAmps =
        Number(amps[previousIndex]);

      if (
        Number.isFinite(dt) &&
        dt > 0 &&
        dt < 1 &&
        Number.isFinite(currentAmps) &&
        Number.isFinite(previousAmps)
      ) {
        const averageAmps =
          (currentAmps + previousAmps) / 2;

        ampSeconds += averageAmps * dt;
      }
    }

    consumedMah = Math.round(
      (ampSeconds / 3600) * 1000
    );
  }

  // ---- estimated internal resistance ----
  //
  // Only evaluate current steps that occur fully inside
  // stable flight. This avoids startup and transition sag.
  //
  // And only when voltage and current tell one story: when the
  // voltage cross-check had to override the ESC's reading, the
  // volts here come from the FC while the amps come from the ESC —
  // two sensors with different filtering, whose step response is
  // not an internal-resistance measurement. Better no estimate
  // than a trended wrong one.
  let internalResistancePerCell = null;
  let internalResistanceNote = null;

  if (!amps) {
    internalResistanceNote = "braucht einen Stromsensor";
  } else if (voltageSourceNote !== null) {
    internalResistanceNote =
      "nicht geschätzt: Spannung und Strom stammen von verschiedenen Sensoren";
  }

  if (
    amps &&
    amps.length === volts.length &&
    voltageSourceNote === null
  ) {
    const stableSet =
      new Set(stableIndexes);

    let best = null;

    for (
      let index = 50;
      index < amps.length;
      index += 1
    ) {
      if (
        !stableSet.has(index) ||
        !stableSet.has(index - 50)
      ) {
        continue;
      }

      const deltaAmps =
        amps[index] - amps[index - 50];

      if (deltaAmps > 15) {
        const deltaVolts =
          volts[index - 50] - volts[index];

        if (deltaVolts > 0) {
          const packResistance =
            deltaVolts / deltaAmps;

          if (
            best === null ||
            packResistance < best
          ) {
            best = packResistance;
          }
        }
      }
    }

    if (best !== null) {
      internalResistancePerCell =
        (best / cellCount) * 1000;
    } else {
      internalResistanceNote =
        "keine sauberen Laststufen im stabilen Flug, an denen sich messen ließe";
    }
  }

  // Do not diagnose pack age or condition from ordinary
  // discharge alone. A brief loaded dip is evidence to
  // review, not proof that a pack is tired.
  const status =
    minimumPerCell < 3.45
      ? "attention"
      : minimumPerCell < 3.6
        ? "watch"
        : "good";

  const story =
    status === "good"
      ? `Die Packspannung blieb im stabilen Flug im normalen, geprüften Bereich. Sie begann im analysierten Fenster bei etwa ${startVolts.toFixed( 1 )} V und endete bei etwa ${endVolts.toFixed( 1 )} V. Die niedrigste Spannung im Flug war ${flightMinVolts.toFixed( 1 )} V (${minimumPerCell.toFixed( 2 )} V pro Zelle). Kein klares Anzeichen für einen schwachen oder müden Akku.`
      : status === "watch"
        ? `Die niedrigste Spannung im Flug war ${flightMinVolts.toFixed( 1 )} V (${minimumPerCell.toFixed( 2 )} V pro Zelle). Ein einzelner Einbruch auf dieses Niveau spiegelt meist die Last dieses Moments wider und nicht einen müden Akku: Das passende Strom- und Gas-Ereignis unten zeigt, was von ihm verlangt wurde.`
        : `Die Spannung im Flug erreichte ${flightMinVolts.toFixed( 1 )} V (${minimumPerCell.toFixed( 2 )} V pro Zelle). Das ist tief genug, um zu zählen: Anhaltend so niedrige Werte gehen meist auf einen alternden Akku oder eine weiche Zelle, einen Stecker- oder Kabelabfall unter Strom oder mehr Last zurück, als die Kapazität des Akkus bequem liefert.`;

  const metrics = [
    {
      label: "Akku (erkannt)",
      value: `${cellCount}S (geschätzt)`
    },
    {
      label: "Stabiler Flug Anfang → Ende",
      value: `${startVolts.toFixed( 1 )} → ${endVolts.toFixed(1)} V (geschätzt)`
    },
    {
      label: "Niedrigste Spannung im Flug",
      value: `${flightMinVolts.toFixed( 1 )} V (${minimumPerCell.toFixed( 2 )} V/Zelle)`
    },
    {
      label: "Spannungsabfall im stabilen Flug",
      value: `${flightVoltageDropPercent.toFixed(1)}%`
    },
    {
      label: "Verwendete stabile Samples",
      value: stableIndexes.length.toLocaleString()
    }
  ];

  if (
    Number.isFinite(consumedMah) &&
    consumedMah > 0
  ) {
    metrics.push({
      label: "Verbrauch im stabilen Flug",
      value: `~${consumedMah} mAh (geschätzt)`
    });
  } else {
    metrics.push({
      label: "Verbrauch im stabilen Flug",
      value: "— braucht einen Stromsensor"
    });
  }

  if (
    Number.isFinite(internalResistancePerCell)
  ) {
    metrics.push({
      label: "Innenwiderstand",
      value: `~${internalResistancePerCell.toFixed( 1 )} mΩ/Zelle (geschätzt)`
    });
  } else if (internalResistanceNote) {
    metrics.push({
      label: "Innenwiderstand",
      value: `— ${internalResistanceNote}`
    });
  }

  return {
    status,
    story: voltageSourceNote
      ? `${story} ${voltageSourceNote}`
      : story,
    metrics,

    sagPercent:
      Math.round(
        flightVoltageDropPercent * 100
      ) / 100,

    internalResistance:
      Number.isFinite(
        internalResistancePerCell
      )
        ? Math.round(
            internalResistancePerCell * 10
          ) / 10
        : null,

    endVoltsPerCell:
      Math.round(endPerCell * 100) / 100,

    minimumVoltsPerCell:
      Math.round(
        minimumPerCell * 100
      ) / 100,

    stableSampleCount:
      stableIndexes.length
  };
}