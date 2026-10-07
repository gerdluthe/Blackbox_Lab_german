// ======================================================
// BLACKBOX LAB — SIGNAL LAB ANALYSIS
// ======================================================
//
// "Was the radio link healthy and reliable throughout
// this flight?"
//
// Everything here is read the way the flight controller
// saw it: the logged rssi column is the control link's
// strength AS RECEIVED, and the slow-frame flags
// (failsafePhase, rxSignalReceived, rxFlightChannelsValid)
// are the firmware's own account of link state. Protocols
// scale rssi differently, so no absolute threshold is ever
// applied — degradation is measured against this flight's
// OWN typical level, and only the firmware's flags speak
// with authority about loss of control.
//
// What the log cannot say, the lab does not say: missing
// fields report Not Evaluated, and telemetry-only trouble
// is never claimed as control loss.
//
// ======================================================

import {
  detectInFlightSamples,
  estimateSampleRate,
  buildRollingMean
} from "./flightPhase.js";

export const SIGNAL_LAB_TUNING = {
  // Degradation is relative to the flight's own median level.
  DEGRADED_SHARE_OF_TYPICAL: 0.7,
  DEEP_SHARE_OF_TYPICAL: 0.4,
  // A dip must persist to be an event — single-sample flickers
  // are reporting noise, not radio behavior.
  MINIMUM_EVENT_SECONDS: 0.2,
  MERGE_GAP_SECONDS: 0.5,
  SMOOTHING_SECONDS: 0.25,
  MAXIMUM_EVENTS: 16,
  // Verdict weights: firmware flags outrank any rssi read.
  DEEP_EVENTS_FOR_ATTENTION: 2,
  DEGRADED_EVENTS_FOR_WATCH: 1
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

// Contiguous runs of a predicate over a set of indexes that are
// consecutive in the source arrays. Returns [{startIndex, endIndex}].
function findRuns(indexes, predicate) {
  const runs = [];
  let start = null;
  let previous = null;

  for (const index of indexes) {
    const hit = predicate(index);
    const continuous = previous !== null && index === previous + 1;

    if (hit && (start === null || !continuous)) {
      if (start !== null) {
        runs.push({ startIndex: start, endIndex: previous });
      }
      start = index;
    } else if (!hit && start !== null) {
      runs.push({ startIndex: start, endIndex: previous });
      start = null;
    }

    previous = index;
  }

  if (start !== null) {
    runs.push({ startIndex: start, endIndex: previous });
  }

  return runs;
}

export function analyzeSignalLab({
  timeSeconds,
  rssi,
  failsafePhase,
  rxSignalReceived,
  rxFlightChannelsValid,
  headspeed
} = {}) {
  const hasRssi = columnCarriesData(rssi);
  const hasFlags =
    Array.isArray(failsafePhase) ||
    Array.isArray(rxSignalReceived) ||
    Array.isArray(rxFlightChannelsValid);

  if (!hasRssi && !hasFlags) {
    return null;
  }

  const tuning = SIGNAL_LAB_TUNING;
  const sampleRate = estimateSampleRate(timeSeconds) ?? 100;

  const airborne =
    detectInFlightSamples({ timeSeconds, headspeed }) ??
    timeSeconds.map((_, index) => index);

  if (airborne.length < 100) {
    return null;
  }

  const seconds = (startIndex, endIndex) =>
    Math.max(
      0,
      (timeSeconds[endIndex] ?? 0) - (timeSeconds[startIndex] ?? 0)
    );

  const mergeRuns = (runs) => {
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
    return merged;
  };

  const events = [];
  const metrics = [];
  const findings = [];

  // ---- the firmware's own account: failsafe + rx flags ----
  let failsafeEventCount = 0;
  let linkLossEventCount = 0;

  if (Array.isArray(failsafePhase)) {
    const runs = mergeRuns(
      findRuns(airborne, (index) => Number(failsafePhase[index]) > 0)
    );

    for (const run of runs) {
      failsafeEventCount += 1;
      events.push({
        kind: "failsafe",
        startSeconds: timeSeconds[run.startIndex],
        endSeconds: timeSeconds[run.endIndex],
        durationMs: Math.round(seconds(run.startIndex, run.endIndex) * 1000),
        detail: "Firmware ist in Failsafe gegangen: Die Steuerverbindung war lang genug unterbrochen, damit die Failsafe-Stufe anspringt."
      });
    }
  }

  const lossFlags = [
    { values: rxSignalReceived, label: "kein Signal empfangen" },
    { values: rxFlightChannelsValid, label: "Flugkanäle ungültig" }
  ];

  for (const flag of lossFlags) {
    if (!Array.isArray(flag.values)) continue;
    if (!columnCarriesData(flag.values) && Number(flag.values[airborne[0]]) === 1) {
      // Constant healthy all flight — nothing to report, and that
      // IS the good result.
      continue;
    }

    const runs = mergeRuns(
      findRuns(airborne, (index) => {
        const value = Number(flag.values[index]);
        return Number.isFinite(value) && value === 0;
      })
    ).filter(
      (run) => seconds(run.startIndex, run.endIndex) >= 0.05
    );

    for (const run of runs) {
      linkLossEventCount += 1;
      events.push({
        kind: "link-loss",
        startSeconds: timeSeconds[run.startIndex],
        endSeconds: timeSeconds[run.endIndex],
        durationMs: Math.round(seconds(run.startIndex, run.endIndex) * 1000),
        detail: `Empfänger meldete ${flag.label}.`
      });
    }
  }

  // ---- rssi: this flight's own level as the yardstick ----
  let typicalRssi = null;
  let minimumRssi = null;
  let degradedEventCount = 0;
  let deepEventCount = 0;
  let capability = hasRssi ? "full" : "flags-only";

  if (hasRssi) {
    const smoothingSamples = Math.max(
      3,
      Math.round(tuning.SMOOTHING_SECONDS * sampleRate)
    );
    const smoothed = buildRollingMean(rssi, smoothingSamples);

    const airborneValues = airborne
      .map((index) => Number(smoothed[index]))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);

    if (airborneValues.length >= 100) {
      typicalRssi =
        airborneValues[Math.floor(airborneValues.length / 2)];
      minimumRssi = airborneValues[0];

      const minimumEventSamples = Math.max(
        3,
        Math.round(tuning.MINIMUM_EVENT_SECONDS * sampleRate)
      );

      const degradedRuns = mergeRuns(
        findRuns(airborne, (index) => {
          const value = Number(smoothed[index]);
          return (
            Number.isFinite(value) &&
            typicalRssi > 0 &&
            value < typicalRssi * tuning.DEGRADED_SHARE_OF_TYPICAL
          );
        })
      ).filter(
        (run) =>
          run.endIndex - run.startIndex + 1 >= minimumEventSamples
      );

      for (const run of degradedRuns) {
        let lowest = Infinity;
        for (let i = run.startIndex; i <= run.endIndex; i += 1) {
          const value = Number(smoothed[i]);
          if (Number.isFinite(value) && value < lowest) lowest = value;
        }

        const deep =
          typicalRssi > 0 &&
          lowest < typicalRssi * tuning.DEEP_SHARE_OF_TYPICAL;

        if (deep) {
          deepEventCount += 1;
        } else {
          degradedEventCount += 1;
        }

        events.push({
          kind: deep ? "deep-degradation" : "degradation",
          startSeconds: timeSeconds[run.startIndex],
          endSeconds: timeSeconds[run.endIndex],
          durationMs: Math.round(
            seconds(run.startIndex, run.endIndex) * 1000
          ),
          detail: `Signal fiel auf ${Math.round(lowest)} (typisch für diesen Flug: ${Math.round(typicalRssi)})${deep ? ", ein tiefer Einbruch" : ""}, erholte sich dann.`
        });
      }
    } else {
      capability = "flags-only";
    }
  }

  events.sort((a, b) => a.startSeconds - b.startSeconds);
  const cappedEvents = events.slice(0, tuning.MAXIMUM_EVENTS);

  // ---- verdict: flags outrank rssi ----
  const status =
    failsafeEventCount > 0 || linkLossEventCount > 0
      ? "attention"
      : deepEventCount >= tuning.DEEP_EVENTS_FOR_ATTENTION
        ? "attention"
        : deepEventCount > 0 ||
            degradedEventCount >= tuning.DEGRADED_EVENTS_FOR_WATCH
          ? "watch"
          : "good";

  // ---- metrics: only what the log actually carries ----
  if (typicalRssi !== null) {
    metrics.push({
      label: "Typische Verbindungsstärke (wie geloggt)",
      value: `${Math.round(typicalRssi)}`
    });
    metrics.push({
      label: "Schwächster Moment (wie geloggt)",
      value: `${Math.round(minimumRssi)}`
    });
  } else {
    metrics.push({
      label: "Verbindungsstärke",
      value: "Nicht geloggt. Verbindungszustand nur aus Empfänger-Flags gelesen"
    });
  }

  metrics.push({
    label: "Failsafe-Ereignisse",
    value: Array.isArray(failsafePhase)
      ? String(failsafeEventCount)
      : "Nicht geloggt"
  });

  metrics.push({
    label: "Verbindungsverlust-Meldungen",
    value:
      Array.isArray(rxSignalReceived) ||
      Array.isArray(rxFlightChannelsValid)
        ? String(linkLossEventCount)
        : "Nicht geloggt"
  });

  if (typicalRssi !== null) {
    metrics.push({
      label: "Signaleinbrüche (relativ zu diesem Flug)",
      value: `${degradedEventCount + deepEventCount}${deepEventCount > 0 ? ` (${deepEventCount} tief)` : ""}`
    });
  }

  // ---- the story ----
  const story =
    failsafeEventCount > 0
      ? `Die Firmware ist im Flug ${failsafeEventCount === 1 ? "einmal" : `${failsafeEventCount} Mal`} in Failsafe gegangen: Die Steuerverbindung wurde tatsächlich unterbrochen. Die Ereigniszeiten unten markieren jede Unterbrechung; auf der Hardware-Seite sind Antennenplatzierung, Ausrichtung und Zustand die üblichen Quellen.`
      : linkLossEventCount > 0
        ? `Der Empfänger meldete ${linkLossEventCount === 1 ? "einen Moment" : `${linkLossEventCount} Momente`} mit verlorenem oder ungültigem Signal. Der Flug ging weiter, aber das ist der eigene Bericht der Firmware über die Verbindung; Antennen, Verkabelung und Empfängerplatzierung sind die üblichen Quellen.`
        : deepEventCount > 0
          ? `Die Verbindung hielt, aber sie brach ${deepEventCount === 1 ? "einmal" : `${deepEventCount} Mal`} tief relativ zum typischen Niveau dieses Fluges ein. Ein tiefer Einbruch kann Orientierungsabschattung sein; wiederholte Einbrüche weisen auf Antennenplatzierung oder -beschädigung hin.`
          : degradedEventCount > 0
            ? `Die Signalstärke brach kurz ${degradedEventCount === 1 ? "einmal" : `${degradedEventCount} Mal`} ein, blieb aber von Problemen entfernt und der Empfänger meldete nie ein Problem: normal bei Ausrichtungsänderungen auf Distanz.`
            : capability === "flags-only"
              ? "Keine Signalstärke-Telemetrie geloggt, aber die eigenen Flags des Empfängers blieben den ganzen Flug gesund: kein Failsafe, keine Momente mit ungültigem Signal."
              : "Die Verbindung blieb den ganzen Flug stark und stabil: kein Failsafe, keine Verlustmeldungen, keine nennenswerten Einbrüche unter das typische Niveau dieses Fluges.";

  if (typicalRssi !== null) {
    findings.push(
      "Signalmessungen werden gegen das typische Niveau dieses Fluges verglichen, nie gegen absolute Schwellwerte: Verschiedene Empfänger und Protokolle skalieren diese Zahlen unterschiedlich."
    );
  }
  findings.push(
    "Eine Telemetrie-Unterbrechung wird nie als Steuerungsverlust gelesen: Nur der eigene Failsafe und die Signalflaggen des Empfängers sprechen für die Steuerverbindung."
  );

  return {
    status,
    capability,
    story,
    metrics,
    events: cappedEvents,
    counts: {
      failsafe: failsafeEventCount,
      linkLoss: linkLossEventCount,
      degraded: degradedEventCount,
      deep: deepEventCount
    },
    typicalRssi,
    minimumRssi,
    findings
  };
}
