// ======================================================
// BLACKBOX LAB — ESC LAB ANALYSIS
// ======================================================
//
// Charts may show the complete recording.
//
// ESC conclusions use only stable governed-flight
// samples. Spool-up, spool-down, ground operation and
// headspeed-profile transitions are excluded.
//
// ======================================================

import {
  detectStableFlightPhase,
  detectInFlightSamples
} from "./flightPhase.js";
import { chooseVoltageSource } from "./batteryLabAnalysis.js";

function statsOf(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  let minimum = Infinity;
  let maximum = -Infinity;
  let sum = 0;
  let count = 0;

  for (const value of values) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      continue;
    }

    if (numericValue < minimum) {
      minimum = numericValue;
    }

    if (numericValue > maximum) {
      maximum = numericValue;
    }

    sum += numericValue;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return {
    min: minimum,
    max: maximum,
    average: sum / count,
    count
  };
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
export function analyzeEscLab({
  timeSeconds,
  motor,
  escThrottle,
  amperage,
  escCurrent,
  vbat,
  escVoltage,
  headspeed,
  governorTarget
}) {
    // A current channel must CARRY data to be a source: an all-zero
    // EscI falling back to an all-zero Ibat still measures nothing,
    // and nothing must never be displayed as 0.0 A (#34).
    const selectedAmperage =
    hasUsablePositiveData(escCurrent)
      ? escCurrent
      : hasUsablePositiveData(amperage)
        ? amperage
        : null;

  const { selected: selectedVoltage, note: voltageSourceNote } =
    chooseVoltageSource(escVoltage, vbat);

  const selectedOutput =
    hasUsablePositiveData(escThrottle)
      ? escThrottle
      : motor;

  // A governor target sharpens the stable-phase search but is
  // not required for it: models on an ESC or external governor
  // log rotor speed with no target to compare it against, and
  // the phase detector falls back to headspeed on its own. Only
  // the data this Lab actually reads may bound the sample count.
  const sampleCount = Math.min(
    timeSeconds?.length ?? 0,
    selectedOutput?.length ?? 0,
    headspeed?.length ?? 0
  );

  if (sampleCount < 200) {
    return null;
  }

  const alignedTime =
    timeSeconds.slice(0, sampleCount);

  const alignedMotor =
  selectedOutput.slice(0, sampleCount);
  const alignedHeadspeed =
    headspeed.slice(0, sampleCount);

  const alignedTarget =
    Array.isArray(governorTarget)
      ? governorTarget.slice(0, sampleCount)
      : [];

  const alignedAmperage =
    Array.isArray(selectedAmperage)
       ? selectedAmperage.slice(0, sampleCount)
      : null;

  const alignedVbat =
    Array.isArray(selectedVoltage)
       ? selectedVoltage.slice(0, sampleCount)
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
      story:
        "Kein stabiler Governor-Flugabschnitt war lang genug für eine verlässliche ESC-Bewertung.",
      metrics: [
        {
          label: "Stabile Samples",
          value: String(stableIndexes.length)
        },
        {
          label: "ESC-Ergebnis",
          value: "Zu wenig Daten aus stabilem Flug"
        }
      ],
      stableSampleCount: stableIndexes.length
    };
  }

  const stableMotor = stableIndexes
    .map((index) => alignedMotor[index])
    .filter((value) =>
      Number.isFinite(Number(value))
    )
    .map(Number);

  const motorStats = statsOf(stableMotor);

  if (!motorStats) {
    return null;
  }

  // Rotorflight motor output is normally 0–1000.
  // Some imported logs may already be normalized to 0–100.
  // Classic 1000–2000 output is also supported.
  const fullScale =
    motorStats.max > 1100
      ? 2000
      : motorStats.max > 100
        ? 1000
        : 100;

  const averagePercent =
    (motorStats.average / fullScale) * 100;

  const headroomPercent = Math.max(
    0,
    100 - averagePercent
  );

  let saturatedSamples = 0;

  for (const value of stableMotor) {
    if (value >= fullScale * 0.97) {
      saturatedSamples += 1;
    }
  }

  const saturationPercent =
    (saturatedSamples / stableMotor.length) * 100;

  // Saturation is judged over the whole flight, not only the
  // stable phase. A hard climb pulls the rotor off its plateau,
  // so the seconds with the throttle against the stop drop out
  // of the stable set at exactly the moment that decides whether
  // the power system kept up.
  const inFlightIndexes = detectInFlightSamples({
    timeSeconds: alignedTime,
    headspeed: alignedHeadspeed
  });

  let flightSaturationPercent = saturationPercent;

  if (inFlightIndexes) {
    let flightSaturated = 0;
    let flightCounted = 0;

    for (const index of inFlightIndexes) {
      const value = Number(alignedMotor[index]);

      if (!Number.isFinite(value)) {
        continue;
      }

      flightCounted += 1;

      if (value >= fullScale * 0.97) {
        flightSaturated += 1;
      }
    }

    if (flightCounted >= 100) {
      flightSaturationPercent =
        (flightSaturated / flightCounted) * 100;
    }
  }

  let ampsStats = null;

  if (alignedAmperage) {
    const stableRawAmps = stableIndexes
      .map((index) => alignedAmperage[index])
      .filter((value) =>
        Number.isFinite(Number(value))
      )
      .map(Number);

    const rawAmpsStats =
      statsOf(stableRawAmps);

    const ampsScale =
      rawAmpsStats && rawAmpsStats.max > 500
        ? 100
        : 1;

    ampsStats = rawAmpsStats
      ? statsOf(
          stableRawAmps.map(
            (value) => value / ampsScale
          )
        )
      : null;
  }

  let voltsStats = null;

  if (alignedVbat) {
    const stableRawVolts = stableIndexes
      .map((index) => alignedVbat[index])
      .filter((value) =>
        Number.isFinite(Number(value))
      )
      .map(Number);

    const rawVoltsStats =
      statsOf(stableRawVolts);

    const voltsScale =
      rawVoltsStats &&
      rawVoltsStats.average > 1000
        ? 100
        : rawVoltsStats &&
            rawVoltsStats.average > 100
          ? 10
          : 1;

    voltsStats = rawVoltsStats
      ? statsOf(
          stableRawVolts.map(
            (value) => value / voltsScale
          )
        )
      : null;
  }

  let peakPower = null;

  if (alignedAmperage && alignedVbat) {
    const rawAmpsStats = statsOf(
      alignedAmperage
        .filter((value) =>
          Number.isFinite(Number(value))
        )
        .map(Number)
    );

    const rawVoltsStats = statsOf(
      alignedVbat
        .filter((value) =>
          Number.isFinite(Number(value))
        )
        .map(Number)
    );

    const ampsScale =
      rawAmpsStats && rawAmpsStats.max > 500
        ? 100
        : 1;

    const voltsScale =
      rawVoltsStats &&
      rawVoltsStats.average > 1000
        ? 100
        : rawVoltsStats &&
            rawVoltsStats.average > 100
          ? 10
          : 1;

    let maximumPower = 0;

    for (const index of stableIndexes) {
      const amps =
        Number(alignedAmperage[index]) /
        ampsScale;

      const volts =
        Number(alignedVbat[index]) /
        voltsScale;

      if (
        Number.isFinite(amps) &&
        Number.isFinite(volts)
      ) {
        const power = amps * volts;

        if (power > maximumPower) {
          maximumPower = power;
        }
      }
    }

    if (maximumPower > 0) {
      peakPower = Math.round(maximumPower);
    }
  }

  const status =
    flightSaturationPercent > 2
      ? "attention"
      : headroomPercent < 12
        ? "watch"
        : "good";

  const story =
    status === "good"
      ? `Gesunde Reserve: Der Motorausgang im stabilen Flug liegt im Mittel bei ${averagePercent.toFixed( 1 )} % mit ${headroomPercent.toFixed( 1 )} % mittlerer Reserve, und der Ausgang blieb über den ganzen Flug von seiner Obergrenze entfernt.`
      : status === "watch"
        ? `Der Motorausgang im stabilen Flug liegt im Mittel bei ${averagePercent.toFixed( 1 )} % und lässt ${headroomPercent.toFixed( 1 )} % mittlere Reserve übrig. Die Momente höchster Last unten zeigen, wohin diese Reserve ging und was in diesen Momenten verlangt wurde.`
        : `Das vom ESC gemeldete Gas lag in ${flightSaturationPercent.toFixed( 1 )} % des Fluges bei oder über 97 %. In diesen Momenten hatte der Governor keine Ausgangsreserve mehr: Das System gab alles, was es hatte, und der Flug verlangte mehr, als Übersetzung und Headspeed liefern können.`;

  const metrics = [
    {
      label: "Vom ESC gemeldetes Gas im stabilen Flug",
      value: `${averagePercent.toFixed(1)}%`
    },
    {
      label: "Mittlere Ausgangsreserve",
      value: `${headroomPercent.toFixed(1)}%`
    },
    {
      label: "Flugzeit nahe der Obergrenze",
      value: `${flightSaturationPercent.toFixed(1)}%`
    },
    {
      label: "Verwendete stabile Samples",
      value:
        stableIndexes.length.toLocaleString()
    }
  ];

  if (ampsStats) {
    metrics.push({
      label: "Strom Ø / Spitze im stabilen Flug",
      value: `${ampsStats.average.toFixed( 1 )} / ${ampsStats.max.toFixed( 1 )} A (geschätzt)`
    });
  } else {
    // The same capability state Home and Log Quality report: a fitted
    // sensor with no usable data reads as unavailable, never as zero.
    metrics.push({
      label: "Strom Ø / Spitze im stabilen Flug",
      value: "Nicht verfügbar — keine brauchbare Strom-Telemetrie"
    });
  }

  if (Number.isFinite(peakPower)) {
    metrics.push({
      label: "Spitzenleistung im stabilen Flug",
      value: `~${peakPower} W (geschätzt)`
    });
  }

  return {
    status,
    story: voltageSourceNote
      ? `${story} ${voltageSourceNote}`
      : story,
    metrics,

    averageOutputPercent:
      Math.round(averagePercent * 10) / 10,

    reservePercent:
      Math.round(headroomPercent * 10) / 10,

    saturationPercent:
      Math.round(flightSaturationPercent * 100) / 100,

    stableSaturationPercent:
      Math.round(saturationPercent * 100) / 100,

    stableSampleCount:
      stableIndexes.length
  };
}