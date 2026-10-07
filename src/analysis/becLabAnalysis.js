// ======================================================
// BLACKBOX LAB — BEC LAB ANALYSIS
// ======================================================
//
// "Did the receiver and servos receive stable, reliable
// power throughout this flight?"
//
// The reference voltage is this flight's OWN median — a
// system deliberately running 6.0 V is never judged
// against one running 8.4 V, and the lab never guesses
// what the pilot intended. Events are whole excursions
// (depth AND duration AND repetition), not single
// samples. Brownout language appears only near the
// absolute floor where receivers genuinely die, and a
// dip is read WITH its servo-demand context: voltage
// following a hard collective pump is load response;
// voltage sagging with the servos quiet points at
// wiring, connectors or the BEC itself.
//
// ======================================================

import {
  detectInFlightSamples,
  estimateSampleRate,
  buildRollingMean
} from "./flightPhase.js";

export const BEC_LAB_TUNING = {
  // Event bands, relative to the flight's own median voltage.
  DIP_ENTER_SHARE: 0.95,
  DIP_DEEP_SHARE: 0.88,
  // Absolute territory where receivers/servos genuinely brown
  // out — the only absolute number here, deliberately below any
  // sane BEC setting (5.0/6.0/7.4/8.4 V systems all clear it).
  BROWNOUT_TERRITORY_VOLTS: 4.5,
  MINIMUM_EVENT_SECONDS: 0.05,
  SUSTAINED_EVENT_SECONDS: 0.3,
  MERGE_GAP_SECONDS: 0.4,
  SMOOTHING_SECONDS: 0.1,
  REPEATED_EVENTS: 3,
  MAXIMUM_EVENTS: 16,
  // Servo-demand context: an event overlapping the flight's top
  // quartile of servo activity is load-driven.
  HIGH_DEMAND_QUANTILE: 0.75
};

function columnCarriesData(values) {
  if (!Array.isArray(values)) return false;
  let first = null;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (first === null) {
      first = value;
    } else if (value !== first) {
      return true;
    }
  }
  return false;
}

// Rotorflight logs Vbec in centivolts; other sources may log
// volts. Normalize by magnitude, never by assumption about the
// intended setting.
function toVolts(value, scale) {
  return Number.isFinite(value) ? value / scale : null;
}

function resolveScale(medianRaw) {
  if (!Number.isFinite(medianRaw)) return 1;
  if (medianRaw > 100) return 100;
  if (medianRaw > 20) return 10;
  return 1;
}

// A perfectly steady BEC logs a CONSTANT column — that is the
// good result, not a dead sensor. A column is dead only when it
// is absent, all-zero, or pinned at a value that cannot be a
// receiver voltage on any scale (the 25500 "no sensor" sentinel
// reads as 255 V).
function usableVoltageColumn(values) {
  if (columnCarriesData(values)) {
    return true;
  }

  const first = (values ?? []).find((value) =>
    Number.isFinite(value)
  );

  if (!Number.isFinite(first) || first <= 0) {
    return false;
  }

  const volts = first / resolveScale(first);
  return volts >= 3 && volts <= 13;
}

export function analyzeBecLab({
  timeSeconds,
  vbec,
  servos = [],
  headspeed,
  // From the Signal Lab when available: did the receiver keep
  // reporting a healthy link the whole flight? A voltage trace
  // that "browns out" while the receiver demonstrably kept
  // flying is a measurement-path story, not a power-loss story
  // — a real supply collapse trips failsafe.
  receiverStayedAlive = null
} = {}) {
  if (!usableVoltageColumn(vbec)) {
    return null;
  }

  const tuning = BEC_LAB_TUNING;
  const sampleRate = estimateSampleRate(timeSeconds) ?? 100;

  const airborne =
    detectInFlightSamples({ timeSeconds, headspeed }) ??
    timeSeconds.map((_, index) => index);

  if (airborne.length < 100) {
    return null;
  }

  const smoothingSamples = Math.max(
    3,
    Math.round(tuning.SMOOTHING_SECONDS * sampleRate)
  );
  const smoothedRaw = buildRollingMean(vbec, smoothingSamples);

  const airborneRaw = airborne
    .map((index) => Number(smoothedRaw[index]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (airborneRaw.length < 100) {
    return null;
  }

  const quantileRaw = (q) =>
    airborneRaw[
      Math.min(airborneRaw.length - 1, Math.floor(airborneRaw.length * q))
    ];

  const medianRaw = quantileRaw(0.5);
  const scale = resolveScale(medianRaw);

  const referenceVolts = toVolts(medianRaw, scale);
  const minimumVolts = toVolts(airborneRaw[0], scale);
  const maximumVolts = toVolts(airborneRaw[airborneRaw.length - 1], scale);

  // The chart draws RAW samples; every number above is read from the
  // smoothed (sustained) view of the same airborne window. The two
  // must be auditable against each other: the briefest raw sample is
  // computed here and STATED whenever it undercuts the sustained
  // minimum, so "never below X" can never contradict the chart (#64).
  let rawAirborneMinimum = Number.POSITIVE_INFINITY;
  for (const index of airborne) {
    const value = Number(vbec[index]);
    if (Number.isFinite(value) && value < rawAirborneMinimum) {
      rawAirborneMinimum = value;
    }
  }
  const rawMinimumVolts = Number.isFinite(rawAirborneMinimum)
    ? toVolts(rawAirborneMinimum, scale)
    : null;
  const smoothingMs = Math.round(
    (smoothingSamples / Math.max(sampleRate, 1)) * 1000
  );
  const briefDipNote =
    Number.isFinite(rawMinimumVolts) &&
    minimumVolts - rawMinimumVolts > 0.015
      ? ` Die kürzesten Rohwerte des Diagramms reichen bis ${rawMinimumVolts.toFixed(2)} V; bewertet wird anhand einer ${smoothingMs} ms langen anhaltenden Ansicht, und keiner dieser kurzen Werte hielt lange genug, um als Einbruch zu zählen.`
      : "";
  const spreadVolts =
    toVolts(quantileRaw(0.95), scale) - toVolts(quantileRaw(0.05), scale);

  // ---- servo-demand trace for event context ----
  const activityWindow = Math.max(3, Math.round(sampleRate * 0.2));
  let servoActivity = null;
  let highDemandBar = null;

  const liveServos = (servos ?? []).filter((servo) =>
    columnCarriesData(servo?.values)
  );

  if (liveServos.length > 0) {
    const raw = new Array(timeSeconds.length).fill(0);

    for (const servo of liveServos) {
      const values = servo.values;
      for (let i = 1; i < values.length; i += 1) {
        const a = Number(values[i]);
        const b = Number(values[i - 1]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          raw[i] += Math.abs(a - b);
        }
      }
    }

    servoActivity = buildRollingMean(raw, activityWindow);

    const airborneActivity = airborne
      .map((index) => Number(servoActivity[index]))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    if (airborneActivity.length >= 100) {
      highDemandBar =
        airborneActivity[
          Math.floor(
            airborneActivity.length * tuning.HIGH_DEMAND_QUANTILE
          )
        ];
    } else {
      servoActivity = null;
    }
  }

  // ---- dip events ----
  const enterRaw = medianRaw * tuning.DIP_ENTER_SHARE;
  const deepRaw = medianRaw * tuning.DIP_DEEP_SHARE;
  const minimumEventSamples = Math.max(
    2,
    Math.round(tuning.MINIMUM_EVENT_SECONDS * sampleRate)
  );

  const runs = [];
  let runStart = null;
  let previous = null;

  for (const index of airborne) {
    const value = Number(smoothedRaw[index]);
    const inDip = Number.isFinite(value) && value < enterRaw;
    const continuous = previous !== null && index === previous + 1;

    if (inDip && (runStart === null || !continuous)) {
      if (runStart !== null) {
        runs.push({ startIndex: runStart, endIndex: previous });
      }
      runStart = index;
    } else if (!inDip && runStart !== null) {
      runs.push({ startIndex: runStart, endIndex: previous });
      runStart = null;
    }

    previous = index;
  }
  if (runStart !== null) {
    runs.push({ startIndex: runStart, endIndex: previous });
  }

  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (
      last &&
      (timeSeconds[run.startIndex] ?? 0) -
        (timeSeconds[last.endIndex] ?? 0) <=
        tuning.MERGE_GAP_SECONDS
    ) {
      last.endIndex = run.endIndex;
    } else {
      merged.push({ ...run });
    }
  }

  const events = [];
  let sustainedCount = 0;
  let transientCount = 0;
  let brownoutTerritory = false;

  for (const run of merged) {
    if (run.endIndex - run.startIndex + 1 < minimumEventSamples) {
      continue;
    }

    let lowestRaw = Infinity;
    let lowestIndex = run.startIndex;

    for (let i = run.startIndex; i <= run.endIndex; i += 1) {
      const value = Number(smoothedRaw[i]);
      if (Number.isFinite(value) && value < lowestRaw) {
        lowestRaw = value;
        lowestIndex = i;
      }
    }

    const durationSeconds =
      (timeSeconds[run.endIndex] ?? 0) -
      (timeSeconds[run.startIndex] ?? 0);

    const sustained =
      durationSeconds >= tuning.SUSTAINED_EVENT_SECONDS;
    const deep = lowestRaw < deepRaw;
    const lowestVolts = toVolts(lowestRaw, scale);

    if (
      Number.isFinite(lowestVolts) &&
      lowestVolts < tuning.BROWNOUT_TERRITORY_VOLTS
    ) {
      brownoutTerritory = true;
    }

    if (sustained) {
      sustainedCount += 1;
    } else {
      transientCount += 1;
    }

    // Servo-demand context at the dip.
    let demandContext = null;
    if (servoActivity && highDemandBar !== null) {
      const activityAtDip = Number(servoActivity[lowestIndex]);
      // A near-zero demand bar means the servos barely moved all
      // flight — then NOTHING qualifies as high demand, rather
      // than everything.
      demandContext =
        Number.isFinite(activityAtDip) &&
        highDemandBar > 0 &&
        activityAtDip >= highDemandBar
          ? "high-demand"
          : "quiet";
    }

    events.push({
      kind: deep ? "deep-dip" : "dip",
      sustained,
      demandContext,
      startSeconds: timeSeconds[run.startIndex],
      endSeconds: timeSeconds[run.endIndex],
      durationMs: Math.round(durationSeconds * 1000),
      lowestVolts:
        Math.round(lowestVolts * 100) / 100,
      depthPercent:
        Math.round(
          ((medianRaw - lowestRaw) / medianRaw) * 1000
        ) / 10,
      detail:
        `Die Spannung fiel auf ${lowestVolts.toFixed(2)} V (${(((medianRaw - lowestRaw) / medianRaw) * 100).toFixed(1)} % unter dem Median dieses Fluges von ${referenceVolts.toFixed(2)} V) für ${Math.round(durationSeconds * 1000)} ms` +
        (demandContext === "high-demand"
          ? ", bei hoher Servo-Anforderung, passend zur Last."
          : demandContext === "quiet"
            ? ", bei vergleichsweise ruhigen Servos, was von einfacher Last wegweist."
            : ".")
    });
  }

  events.sort((a, b) => a.startSeconds - b.startSeconds);
  const cappedEvents = events.slice(0, tuning.MAXIMUM_EVENTS);

  const dipCount = sustainedCount + transientCount;
  const worst = events.reduce(
    (best, event) =>
      best === null || event.depthPercent > best.depthPercent
        ? event
        : best,
    null
  );

  // ---- verdict ----
  const implausibleBrownout =
    brownoutTerritory && receiverStayedAlive === true;

  const status = brownoutTerritory
    ? implausibleBrownout
      ? "watch"
      : "attention"
    : sustainedCount > 0 || dipCount >= tuning.REPEATED_EVENTS
      ? "attention"
      : dipCount > 0
        ? "watch"
        : "good";

  const quietDips = events.filter(
    (event) => event.demandContext === "quiet"
  ).length;

  const story = brownoutTerritory
    ? implausibleBrownout
      ? `Die Spannungsanzeige fiel in den Brownout-Bereich (unter ${tuning.BROWNOUT_TERRITORY_VOLTS.toFixed(1)} V). Doch der Empfänger meldete die ganze Zeit eine gesunde Verbindung, und ein echter Versorgungszusammenbruch löst Failsafe aus.\n\nDas deutet auf den Messpfad hin (den Spannungssensor, seine Verkabelung oder seinen Stecker) und nicht auf einen echten BEC-Ausgangsverlust. Eine körperliche Prüfung dieses Pfads lohnt sich; tausche das BEC aufgrund dieses Belegs allein nicht aus.`
      : `Der BEC-Ausgang geriet in echtes Brownout-Gebiet (unter ${tuning.BROWNOUT_TERRITORY_VOLTS.toFixed(1)} V): Dort lassen Empfänger und Servos tatsächlich los.\n\nDie üblichen Quellen: ein BEC, das unterhalb der Servolast eingestellt oder dimensioniert ist, ein schwacher Stecker oder ein Kabelabfall unter Strom, oder klemmende Servos, die den Bedarf weit über das Normale treiben.`
    : sustainedCount > 0
      ? `Die Empfängerspannung blieb über eine längere Strecke niedrig, ${sustainedCount === 1 ? "einmal" : `${sustainedCount} Mal`}: länger, als ein Lastübergang dauern sollte. ${quietDips > 0 ? "Mindestens ein Einbruch geschah bei vergleichsweise ruhigen Servos, was auf Verkabelung, Stecker oder das BEC statt auf Last hindeutet. " : "Die Einbrüche passen zur Servo-Anforderung, beginne also mit Servolast und mechanischem Klemmen. "}Die Ereignisse unten nennen jeden Moment.`
      : dipCount >= tuning.REPEATED_EVENTS
        ? `Die Empfängerspannung brach in diesem Flug ${dipCount} Mal ein. Jeder erholte sich, aber bei der Stromversorgung zählt das Muster der Wiederholung. Die Ereignisse unten nennen jeden Moment; Einbrüche, die bei ähnlicher Last wiederkehren, gehen meist auf Stecker, Verkabelung oder Servolast zurück.`
        : dipCount > 0
          ? `${dipCount === 1 ? "Ein kurzer" : `${dipCount} kurze`} Spannungseinbr${dipCount === 1 ? "uch" : "üche"}, normal erholt: ${quietDips === 0 ? "im Gleichschritt mit der Servo-Anforderung, das ist ein Antriebssystem, das unter Last seine Arbeit tut." : "einen Blick auf den Ereigniskontext unten wert."} Nichts hier deutet auf eine instabile Versorgung hin.`
          : `Der BEC-Ausgang blieb im analysierten Flugfenster stabil: ${referenceVolts.toFixed(2)} V typisch, niedrigster anhaltender Wert ${minimumVolts.toFixed(2)} V, Gesamtschwankung ${(spreadVolts >= 0 ? spreadVolts : 0).toFixed(2)} V. So sieht ein gesundes BEC aus.${briefDipNote} (Start- und Abschalt-Samples liegen außerhalb dieses Fensters: Das Diagramm kann dort niedrigere Werte zeigen.)`;

  const metrics = [
    {
      label: "Typische Spannung (Median dieses Fluges)",
      value: `${referenceVolts.toFixed(2)} V`
    },
    {
      label: "Bereich im Flug",
      value: `${minimumVolts.toFixed(2)} – ${maximumVolts.toFixed(2)} V (anhaltend)`
    },
    ...(Number.isFinite(rawMinimumVolts) && minimumVolts - rawMinimumVolts > 0.015
      ? [
          {
            label: "Kürzester Rohwert",
            value: `${rawMinimumVolts.toFixed(2)} V — zu kurz, um als Einbruch zu zählen`
          }
        ]
      : []),
    {
      label: "Stabilität (Streuung 5.–95. Perzentil)",
      value: `${(spreadVolts >= 0 ? spreadVolts : 0).toFixed(2)} V`
    },
    {
      label: "Spannungseinbrüche",
      value: `${dipCount}${sustainedCount > 0 ? ` (${sustainedCount} anhaltend)` : ""}`
    },
    ...(worst
      ? [
          {
            label: "Schlimmstes Ereignis",
            value: `${worst.lowestVolts.toFixed(2)} V (${worst.depthPercent.toFixed(1)} %) für ${worst.durationMs} ms bei ${worst.startSeconds.toFixed(1)} s`
          }
        ]
      : [])
  ];

  const findings = [
    "Die Referenz ist die Median-Spannung dieses Fluges: Ein System, das bewusst mit 6,0 V läuft, wird nie an einem mit 8,4 V gemessen.",
    "Ereignisse werden nach Tiefe, Dauer und Wiederholung zusammen beurteilt, nie nach einem einzelnen niedrigsten Messwert."
  ];

  if (servoActivity === null) {
    findings.push(
      "Keine brauchbaren Servo-Daten in diesem Log, deshalb ließen sich Einbrüche nicht an der Servo-Anforderung ablesen."
    );
  }

  return {
    status,
    capability: "full",
    story,
    metrics,
    events: cappedEvents,
    counts: {
      dips: dipCount,
      sustained: sustainedCount,
      transient: transientCount,
      quietContext: quietDips
    },
    referenceVolts,
    minimumVolts,
    rawMinimumVolts,
    maximumVolts,
    brownoutTerritory,
    implausibleBrownout,
    scale,
    findings
  };
}

// ------------------------------------------------------
// Cross-lab correlation: when a link event and a power
// event overlap in time, each lab points at the other —
// correlation named, causation never claimed.
// ------------------------------------------------------
export function correlateSignalAndPower(signalResult, becResult) {
  if (!signalResult?.events?.length || !becResult?.events?.length) {
    return null;
  }

  const overlaps = [];

  for (const signalEvent of signalResult.events) {
    for (const becEvent of becResult.events) {
      const start = Math.max(
        signalEvent.startSeconds,
        becEvent.startSeconds
      );
      const end = Math.min(
        signalEvent.endSeconds + 0.5,
        becEvent.endSeconds + 0.5
      );

      if (end >= start) {
        overlaps.push({
          atSeconds: Math.round(start * 10) / 10,
          signalKind: signalEvent.kind,
          becKind: becEvent.kind
        });
      }
    }
  }

  if (overlaps.length === 0) {
    return null;
  }

  const at = overlaps
    .slice(0, 3)
    .map((overlap) => `${overlap.atSeconds.toFixed(1)} s`)
    .join(", ");

  return {
    overlaps,
    signalSentence: ` Zur selben Zeit trat ein Empfängerversorgungs-Ereignis auf (${at}). Das BEC-Labor trägt die andere Hälfte dieser Geschichte.`,
    becSentence: ` Zur selben Zeit trat ein Link-Ereignis auf (${at}). Das Signal-Labor trägt die andere Hälfte dieser Geschichte.`
  };
}
