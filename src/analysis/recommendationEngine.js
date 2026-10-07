// ======================================================
// BLACKBOX LAB — RECOMMENDATION ENGINE
// ======================================================
//
// The layer that turns findings into "where to start":
// one recommendation object per pattern, carrying its own
// evidence, its confidence, and — only above the gate — a
// directional suggestion.
//
// House rules, non-negotiable:
//   · Blackbox Lab NEVER silently changes anything; it
//     recommends and explains, the pilot decides.
//   · A directional suggestion needs HIGH confidence, a
//     pattern of at least MINIMUM_EVENTS comparable events,
//     and no conflicting higher-priority finding. Below the
//     gate the same object renders as a "review" finding —
//     one schema, both moods, no second code path to drift.
//   · One suggestion names ONE setting family and a
//     direction with a magnitude CLASS, never a number —
//     numbers depend on craft and firmware defaults a log
//     cannot fully know.
//   · Workflow order is enforced: an open vibration/filter
//     concern silences PID suggestions (filters come before
//     PIDs), and a power-limit event silences governor
//     suggestions (hardware before tune).
//   · Every suggestion ends with its verify plan: it rides
//     in the flight's pack (at most PACK_CAP changes, one per
//     instrument), fly again, let the pack check and the
//     named metric be the judge.
//
// ======================================================

import { commandEvidenceConfidence } from "./pidAnalysis.js";
import { estimateSampleRate } from "./flightPhase.js";
import {
  finalizeRecommendations,
  confirmsFromResponseBehavior,
  rankRecommendations
} from "./recommendationContract.js";

export const RECOMMENDATION_GATE = {
  MINIMUM_EVENTS: 2,
  SLOW_SETTLING_MS: 500,
  // Slow-settle shares re-anchored 2026-08-18 (same sweep as the
  // overshoot anchors; per-axis split and rationale unchanged:
  // yaw settles slow as its nature, roll fast). Bars sit at each
  // axis's fleet p90, yaw at p95: Roll p90 0.125, Pitch p90
  // 0.118, Yaw p95 0.219.
  // Yaw re-read 2026-08-23 on the post-ghost-fix fleet: yaw pirouettes are the long ramps the ghost events
  // rode on; with them gone yaw's p95 slow share reads 0.18.
  SLOW_SETTLE_SHARE_MINIMUM: {
    Roll: 0.13,
    Pitch: 0.12,
    Yaw: 0.18
  },
  HUNTING_MINIMUM_CROSSINGS: 3,
  // Governor excursions are fleet-rare by calibration (median
  // machine: zero), so three same-cause excursions in ONE flight
  // is already a strong pattern.
  GOVERNOR_HIGH_CONFIDENCE_EVENTS: 3,
  // Overshoot: re-calibrated 2026-08-18 after the reversal-
  // termination refinement (contributed-fleet axes with >=5
  // clean responses — compound slurred-command events no
  // longer inflate the tail). Same doctrine as always: bars at
  // the fleet's p90, so a card names a machine, not the formula.
  // Share of clean commands overshooting >=25% AND >=10 deg/s at
  // fleet p90 (0.50), per-axis median overshoot at fleet p90
  // (34%), at least three events.
  OVERSHOOT_REVIEW_PERCENT: 25,
  OVERSHOOT_MINIMUM_DEG_S: 10,
  OVERSHOOT_MINIMUM_EVENTS: 3,
  OVERSHOOT_SHARE_MINIMUM: 0.5,
  OVERSHOOT_MEDIAN_MINIMUM_PERCENT: 34,
  OVERSHOOT_CORRELATION_MINIMUM_EVENTS: 5,
  OVERSHOOT_CORRELATION_STRONG: 0.6,
  OVERSHOOT_CORRELATION_GAP: 0.25
};

// Spearman rank correlation — the driver signature lives in how
// overshoot GROWS with a candidate driver, not in absolute values,
// so ranks are the honest measure at these sample sizes.
function spearmanCorrelation(a, b) {
  if (a.length !== b.length || a.length < 3) {
    return null;
  }

  // Ties share their average rank — without this, a CONSTANT
  // series gets ranks in input order and correlates perfectly
  // with anything sorted, which is exactly backwards.
  const rankOf = (values) => {
    const indexed = values
      .map((value, index) => ({ value, index }))
      .sort((x, y) => x.value - y.value);

    const ranks = new Array(values.length);
    let i = 0;

    while (i < indexed.length) {
      let j = i;

      while (
        j + 1 < indexed.length &&
        indexed[j + 1].value === indexed[i].value
      ) {
        j += 1;
      }

      const sharedRank = (i + j) / 2;

      for (let k = i; k <= j; k += 1) {
        ranks[indexed[k].index] = sharedRank;
      }

      i = j + 1;
    }

    return ranks;
  };

  const ra = rankOf(a);
  const rb = rankOf(b);
  const meanRank = (a.length - 1) / 2;

  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const da = ra[i] - meanRank;
    const db = rb[i] - meanRank;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : null;
}

// Gap-robust: a logging dropout stretches an endpoint average and
// would inflate every settling duration; the median interval the
// sibling modules use is unaffected.
function sampleSpacingMs(timeSeconds) {
  const rate = estimateSampleRate(timeSeconds);
  return Number.isFinite(rate) && rate > 0 ? 1000 / rate : null;
}

// The Rotorflight CLI family a suggestion points at, per axis.
const AXIS_SETTING_FAMILY = {
  Roll: {
    damping: "roll_d_gain",
    drive: "roll_f_gain",
    proportional: "roll_p_gain"
  },
  Pitch: {
    damping: "pitch_d_gain",
    drive: "pitch_f_gain",
    proportional: "pitch_p_gain"
  },
  Yaw: {
    damping: "yaw_d_gain",
    drive: "yaw_f_gain",
    proportional: "yaw_p_gain"
  }
};

/**
 * Build the flight's recommendations from what the analyses
 * already measured. Everything here READS structured results —
 * nothing is re-measured, so a recommendation can never disagree
 * with the finding it cites.
 *
 * @param {object} options {
 *     trackingAnalysis,   // pidAnalysis.detectedColumns.trackingAnalysis
 *     commandBalanceReviewAxes, // pidAnalysis.technicalSummary
 *     timeSeconds,        // flight timeline (for ms conversion)
 *     governorEvents,     // detectGovernorEvents result or null
 *     vibrationConcern,   // boolean: open vibration/filter finding
 *   }
 * Returns { pid: [...], governor: [...] } — each entry a
 * recommendation object; empty arrays when there is nothing to say.
 */
export function buildRecommendations({
  trackingAnalysis = null,
  commandBalanceReviewAxes = [],
  timeSeconds = null,
  governorEvents = null,
  precomp = null,
  vibrationConcern = false,
  responseBehavior = null
} = {}) {
  // Every recommendation leaves this function wearing the contract
  // (level, domain, instrument, next maneuver) — the one shape all
  // surfaces render and the pack builder selects from.
  const nextSteps = finalizeRecommendations({
    pid: buildPidRecommendations({
      trackingAnalysis,
      commandBalanceReviewAxes,
      timeSeconds,
      vibrationConcern
    }),
    governor: buildGovernorRecommendations({
      governorEvents,
      precomp,
      vibrationConcern
    })
  });

  // Response-behavior Reviews below the gates still deserve their
  // evidence flight — the report already says so, and the contract
  // must agree with the report (one axis, one entry, no duplicates
  // where the engine already spoke).
  nextSteps.pid.push(
    ...confirmsFromResponseBehavior(responseBehavior, nextSteps.pid)
  );

  // One priority rule for every surface (#62): the first entry here
  // IS the primary next action — Home, the pack, the PID Lab card,
  // the Technical recommendations and the report all read this order.
  nextSteps.pid = rankRecommendations(nextSteps.pid);
  nextSteps.governor = rankRecommendations(nextSteps.governor);

  return nextSteps;
}

function buildPidRecommendations({
  trackingAnalysis,
  commandBalanceReviewAxes,
  timeSeconds,
  vibrationConcern
}) {
  const perAxis = trackingAnalysis?.commandEvents ?? [];
  const dtMs = sampleSpacingMs(timeSeconds);
  const gate = RECOMMENDATION_GATE;
  const recommendations = [];

  for (const axisResult of perAxis) {
    const axis = axisResult?.axis;
    const events = Array.isArray(axisResult?.events)
      ? axisResult.events
      : [];

    if (!axis || !AXIS_SETTING_FAMILY[axis]) {
      continue;
    }

    const cleanResponses = events.filter((event) =>
      Number.isFinite(event.responsePeak)
    );

    const confidence = commandEvidenceConfidence(
      cleanResponses.length
    );

    const slowEvents = cleanResponses.filter(
      (event) =>
        event.settlingDetected &&
        Number.isFinite(event.settlingDurationSamples) &&
        Number.isFinite(dtMs) &&
        event.settlingDurationSamples * dtMs >
          gate.SLOW_SETTLING_MS
    );

    const overshootRecommendation = buildOvershootRecommendation({
      axis,
      cleanResponses,
      confidence,
      vibrationConcern,
      gate
    });

    // Same-knob guard: when the slow-settle rec below already points
    // at damping, a second damping-side overshoot rec on the same
    // axis would say the same thing twice with two findings.
    const pushOvershoot = (slowSuggestedDamping) => {
      if (!overshootRecommendation) {
        return;
      }

      if (slowSuggestedDamping && overshootRecommendation.dampingSide) {
        return;
      }

      delete overshootRecommendation.dampingSide;
      recommendations.push(overshootRecommendation);
    };

    // Count AND share: a long flight accumulates slow events the
    // way any flight accumulates minutes — only an axis where slow
    // settling is a real fraction of its commands has a pattern.
    const slowShare =
      cleanResponses.length > 0
        ? slowEvents.length / cleanResponses.length
        : 0;

    const slowShareBar =
      gate.SLOW_SETTLE_SHARE_MINIMUM[axis] ?? 0.15;

    if (
      slowEvents.length < gate.MINIMUM_EVENTS ||
      slowShare < slowShareBar
    ) {
      pushOvershoot(false);
      continue;
    }

    const huntingSlow = slowEvents.filter(
      (event) =>
        Number.isFinite(event.ringingTargetCrossingCount) &&
        event.ringingTargetCrossingCount >=
          gate.HUNTING_MINIMUM_CROSSINGS
    );

    const huntingMajority =
      huntingSlow.length * 2 > slowEvents.length;

    const driveSide =
      !huntingMajority &&
      commandBalanceReviewAxes.includes(axis);

    const finding =
      `${axis} hat sein Ziel erreicht, aber auf ` +
      `${slowEvents.length} von ${cleanResponses.length} gemessenen Kommandos langsam eingeschwungen` +
      (huntingMajority
        ? ", kreiste den Setpoint ein, bevor es zur Ruhe kam"
        : "") +
      ".";

    const evidence = slowEvents.slice(0, 6).map((event) => ({
      kind: "command-event",
      axis,
      rowIndex: event.sampleRowIndex ?? null,
      settlingMs:
        Number.isFinite(event.settlingDurationSamples) &&
        Number.isFinite(dtMs)
          ? Math.round(event.settlingDurationSamples * dtMs)
          : null,
      ringingCrossings: event.ringingTargetCrossingCount ?? null
    }));

    // The gate: high evidence confidence, a clear damping-or-drive
    // signature, and no open vibration finding.
    let suggestion = null;
    let gatedReason = null;
    let hypothesis;
    let expectedResult = null;
    let verifyMetric = null;

    if (vibrationConcern) {
      hypothesis = huntingMajority
        ? "Die Antwort kreist ihren Setpoint ein, bevor sie zur Ruhe kommt. Aber dieser Flug trägt auch einen offenen Vibrationsbefund, und Gyro-Vibration kann genau diese Signatur erzeugen."
        : "Die Antwort schleicht zu ihrem Ziel. Aber dieser Flug trägt auch einen offenen Vibrationsbefund, der zuerst gelöst werden muss.";
      gatedReason =
        "Filter kommen vor PIDs: Löse den Vibrationsbefund, fliege erneut und lies diese Seite neu.";
    } else if (confidence !== "High") {
      hypothesis = huntingMajority
        ? "Die langsamen Einschwingungen pendeln um den Setpoint, was gewöhnlich auf Dämpfung hinweist. Aber es gibt nicht genug saubere Kommandos in diesem Log, um es zu bestätigen."
        : "Die langsamen Einschwingungen schleichen zum Ziel ohne zu pendeln. Aber es gibt nicht genug saubere Kommandos in diesem Log, um es zu bestätigen.";
      gatedReason = `Beleg-Sicherheit ist ${confidence} (${cleanResponses.length} sauberes Kommando${cleanResponses.length === 1 ? "" : "s"}). Fliege ein Log mit mehr verschiedenen Stick-Eingaben und lies diese Seite neu.`;
    } else if (huntingMajority) {
      hypothesis =
        "Das Ziel zu erreichen und es dann einzukreisen ist die klassische unterdämpfte Signatur: Die Achse hat den Antrieb, um dorthin zu kommen, aber nicht die Dämpfung, um dort zu stoppen.";
      suggestion = {
        family: AXIS_SETTING_FAMILY[axis].damping,
        direction: "up",
        magnitudeClass: "kleiner Schritt"
      };
      expectedResult = `${axis}-Einschwingzeiten sinken zurück zu den sauberen Ereignissen auf dieser Seite, ohne neue Schwingungen bei schnellen Bewegungen.`;
      verifyMetric = `die ${axis}-Langsam-Einschwing-Zahl in Flug-Ereignissen`;
    } else if (driveSide) {
      hypothesis =
        "Die Achse schleicht zu ihrem Ziel, während der I-Anteil das Kommando trägt. In Rotorflight soll Feedforward diese Arbeit leisten.";
      suggestion = {
        family: AXIS_SETTING_FAMILY[axis].drive,
        direction: "up",
        magnitudeClass: "kleiner Schritt"
      };
      expectedResult = `${axis}-Antworten erreichen das Ziel mit weniger I-Anteil-Aufbau, und der Kommando-Balance-Befund bereinigt sich.`;
      verifyMetric = `die ${axis}-Langsam-Einschwing-Zahl in Flug-Ereignissen`;
    } else {
      hypothesis =
        "Die langsamen Einschwingungen tragen weder eine klare Pendel-Signatur noch einen I-Dominanz-Befund, deshalb lassen sich Dämpfung und Antrieb aus diesem Log allein nicht unterscheiden.";
      gatedReason =
        "Gemischte Signatur: Bestätige das Muster mit einem weiteren Log, bevor Werte geändert werden.";
    }

    recommendations.push({
      id: `pid:${axis}:slow-settling`,
      lab: "pid",
      axis,
      finding,
      hypothesis,
      evidence,
      evidenceCount: slowEvents.length,
      confidence,
      suggestion,
      expectedResult,
      verifyMetric,
      gatedReason
    });

    pushOvershoot(
      suggestion?.family === AXIS_SETTING_FAMILY[axis].damping
    );
  }

  return recommendations;
}

// The overshoot driver question: an axis that repeatedly shoots
// past its target is being pushed past it by SOMETHING — damping
// too short (it also rings), feedforward too hot (overshoot grows
// with how FAST the command moved), or proportional drive too hot
// (overshoot grows with how BIG the command was). The signature is
// read from how overshoot grows, never from one event.
function buildOvershootRecommendation({
  axis,
  cleanResponses,
  confidence,
  vibrationConcern,
  gate
}) {
  const measured = cleanResponses.filter((event) =>
    Number.isFinite(event.overshootPercent)
  );

  const big = measured.filter(
    (event) =>
      event.overshootPercent >= gate.OVERSHOOT_REVIEW_PERCENT &&
      Number.isFinite(event.overshootAmount) &&
      event.overshootAmount >= gate.OVERSHOOT_MINIMUM_DEG_S
  );

  const medianBig = big.length
    ? big
        .map((event) => event.overshootPercent)
        .sort((a, b) => a - b)[Math.floor(big.length / 2)]
    : null;

  // The fleet-anchored trigger: all three bars, or silence. See
  // the calibration note on the gate constants — anything looser
  // fires on the median machine.
  if (
    big.length < gate.OVERSHOOT_MINIMUM_EVENTS ||
    cleanResponses.length === 0 ||
    big.length / cleanResponses.length <
      gate.OVERSHOOT_SHARE_MINIMUM ||
    !Number.isFinite(medianBig) ||
    medianBig < gate.OVERSHOOT_MEDIAN_MINIMUM_PERCENT
  ) {
    return null;
  }

  const finding =
    `${axis} hat sein Ziel überschossen (${gate.OVERSHOOT_REVIEW_PERCENT} %+) bei ` +
    `${big.length} von ${cleanResponses.length} gemessenen Kommandos ` +
    `(Median ${Math.round(medianBig)} % am Ziel vorbei).`;

  const evidence = big.slice(0, 6).map((event) => ({
    kind: "command-event",
    axis,
    rowIndex: event.sampleRowIndex ?? null,
    overshootPercent:
      Math.round(event.overshootPercent * 10) / 10,
    ringingCrossings: event.ringingTargetCrossingCount ?? null
  }));

  const base = {
    id: `pid:${axis}:overshoot`,
    lab: "pid",
    axis,
    finding,
    evidence,
    evidenceCount: big.length,
    confidence,
    suggestion: null,
    expectedResult: null,
    verifyMetric: null,
    gatedReason: null,
    dampingSide: false
  };

  if (vibrationConcern) {
    return {
      ...base,
      hypothesis:
        "Wiederholtes Überschwingen mit einem offenen Vibrationsbefund ist nicht lesbar: Gyro-Vibration kann eine Antwort allein über das Ziel hinaus drücken.",
      gatedReason:
        "Filter kommen vor PIDs: Löse den Vibrationsbefund, fliege erneut und lies diese Seite neu."
    };
  }

  if (confidence !== "High") {
    return {
      ...base,
      hypothesis:
        "Die Überschwingungen wiederholen sich, aber es gibt nicht genug saubere Kommandos in diesem Log, um zu lesen, was sie antreibt.",
      gatedReason: `Beleg-Sicherheit ist ${confidence} (${cleanResponses.length} sauberes Kommando${cleanResponses.length === 1 ? "" : "s"}). Fliege ein Log mit mehr verschiedenen Stick-Eingaben und lies diese Seite neu.`
    };
  }

  const ringing = big.filter(
    (event) =>
      Number.isFinite(event.ringingTargetCrossingCount) &&
      event.ringingTargetCrossingCount >=
        gate.HUNTING_MINIMUM_CROSSINGS
  );

  if (ringing.length * 2 > big.length) {
    return {
      ...base,
      dampingSide: true,
      hypothesis:
        "Die Überschwingungen klingen: Die Achse schießt über ihr Ziel hinaus und schwingt, bevor sie zur Ruhe kommt. Der Antrieb gewinnt gegen die Dämpfung.",
      suggestion: {
        family: AXIS_SETTING_FAMILY[axis].damping,
        direction: "up",
        magnitudeClass: "kleiner Schritt"
      },
      expectedResult: `${axis}-Überschwing-Ereignisse schrumpfen und hören auf zu schwingen, ohne dass die Antwort träge wird.`,
      verifyMetric: `die ${axis}-Überschwing-Zahl in Flug-Ereignissen`
    };
  }

  // Driver correlation needs enough measured overshoots to rank.
  if (
    measured.length < gate.OVERSHOOT_CORRELATION_MINIMUM_EVENTS
  ) {
    return {
      ...base,
      hypothesis:
        "Die Überschwingungen wiederholen sich ohne zu schwingen, aber zu wenige Antworten kreuzten das Ziel, um zu lesen, ob Kommandogeschwindigkeit oder -größe sie antreibt.",
      gatedReason:
        "Bestätige das Muster mit einem weiteren Log mit mehr gemessenen Überschwingungen, bevor Werte geändert werden."
    };
  }

  const overshoots = measured.map(
    (event) => event.overshootPercent
  );

  const rates = measured.map((event) => {
    const durationSamples = Math.max(
      1,
      Number.isInteger(event.commandEndSampleIndex) &&
        Number.isInteger(event.sampleIndex)
        ? event.commandEndSampleIndex - event.sampleIndex
        : 1
    );

    return (
      (Number(event.commandMagnitude) || 0) / durationSamples
    );
  });

  const sizes = measured.map(
    (event) => Number(event.commandMagnitude) || 0
  );

  const rhoRate = spearmanCorrelation(overshoots, rates) ?? 0;
  const rhoSize = spearmanCorrelation(overshoots, sizes) ?? 0;

  const rateDriven =
    rhoRate >= gate.OVERSHOOT_CORRELATION_STRONG &&
    rhoRate - rhoSize >= gate.OVERSHOOT_CORRELATION_GAP;

  const sizeDriven =
    rhoSize >= gate.OVERSHOOT_CORRELATION_STRONG &&
    rhoSize - rhoRate >= gate.OVERSHOOT_CORRELATION_GAP;

  if (rateDriven) {
    return {
      ...base,
      hypothesis:
        "Überschwingen wächst damit, wie SCHNELL das Kommando sich bewegt: die Feedforward-Signatur. Es drückt proportional zur Stick-Geschwindigkeit, und hier drückt es über das Ziel hinaus.",
      suggestion: {
        family: AXIS_SETTING_FAMILY[axis].drive,
        direction: "down",
        magnitudeClass: "kleiner Schritt"
      },
      expectedResult: `${axis}-Überschwingen schrumpft zuerst bei schnellen Eingaben: genau dort, wo es jetzt am schlimmsten ist.`,
      verifyMetric: `die ${axis}-Überschwing-Zahl in Flug-Ereignissen`
    };
  }

  if (sizeDriven) {
    return {
      ...base,
      hypothesis:
        "Überschwingen wächst damit, wie GROSS das Kommando war, nicht wie schnell: die Proportionalanteil-Signatur.",
      suggestion: {
        family: AXIS_SETTING_FAMILY[axis].proportional,
        direction: "down",
        magnitudeClass: "kleiner Schritt"
      },
      expectedResult: `${axis}-Überschwingen schrumpft zuerst bei großen Eingaben: genau dort, wo es jetzt am schlimmsten ist.`,
      verifyMetric: `die ${axis}-Überschwing-Zahl in Flug-Ereignissen`
    };
  }

  return {
    ...base,
    hypothesis:
      "Die Überschwingungen sind real, aber ihr Treiber lässt sich aus diesem Log nicht trennen: Sie wachsen weder mit Kommandogeschwindigkeit noch -größe klar genug, um einen Regler zu nennen.",
    suggestion: {
      family: `${AXIS_SETTING_FAMILY[axis].drive}, then ${AXIS_SETTING_FAMILY[axis].proportional}`,
      direction: "down",
      magnitudeClass: "kleiner Schritt"
    },
    expectedResult: `${axis}-Überschwing-Zahl sinkt. In Rotorflight leistet Feedforward die meiste kommandierte Arbeit, deshalb ist er der wahrscheinlichere Treiber: Zuerst diesen anpassen, und ${AXIS_SETTING_FAMILY[axis].proportional} nur anfassen, wenn das nächste Log noch überschwingt.`,
    verifyMetric: `die ${axis}-Überschwing-Zahl in Flug-Ereignissen`
  };
}

function buildGovernorRecommendations({
  governorEvents,
  precomp,
  vibrationConcern = false
}) {
  const events = governorEvents?.events ?? [];
  const gate = RECOMMENDATION_GATE;
  const recommendations = [];

  // The tuning order holds here too: gyro vibration can fake the
  // yaw-error signal the tail read is built on, and shake enough
  // energy into everything else to make any governor conclusion
  // suspect. One silencer, applied to every directional suggestion
  // this builder would otherwise make.
  const silenceForVibration = (recommendation) =>
    vibrationConcern &&
    (recommendation.suggestion ||
      // The tail read is measured from yaw gyro error — the most
      // vibration-sensitive signal here — so its verify-plan
      // guidance yields too, suggestion or not.
      recommendation.id === "governor:tail-coupling")
      ? {
          ...recommendation,
          suggestion: null,
          expectedResult: null,
          verifyMetric: null,
          gatedReason:
            "Dieser Flug trägt einen offenen Vibrationsbefund, und Vibration kann genau diese Signale fälschen. Filter kommen zuerst: Löse ihn, fliege erneut und lies diese Seite neu."
        }
      : recommendation;

  const powerLimitEvents = events.filter(
    (event) => event.cause === "power-limit"
  );

  const collectiveDropEvents = events.filter(
    (event) => event.cause === "collective-drop"
  );

  // Hardware before tune: dips the governor could not have fixed
  // outrank every gain-or-precomp thought, and silence them.
  if (powerLimitEvents.length > 0) {
    recommendations.push({
      id: "governor:power-limit",
      lab: "governor",
      finding:
        `${powerLimitEvents.length} Ausreißer${powerLimitEvents.length === 1 ? "" : ""} mit dem Motorausgang an seiner Obergrenze: ` +
        "Das Antriebssystem hatte in diesen Momenten nichts mehr zu geben.",
      hypothesis:
        "Ein Einbruch ohne Ausgangsreserve ist eine Antriebssystem-Grenze, kein Governor-Tune-Problem: Kein Gain- oder Precomp-Wert kann Leistung hinzufügen, die nicht vorhanden ist.",
      evidence: powerLimitEvents.slice(0, 6).map((event) => ({
        kind: "governor-event",
        eventId: event.id,
        t: event.t,
        peakErrorPercent: event.peakErrorPercent,
        outputMaxPercent: event.outputMaxPercent
      })),
      evidenceCount: powerLimitEvents.length,
      confidence: "High",
      suggestion: null,
      expectedResult: null,
      verifyMetric: null,
      gatedReason:
        "Sieh dir das ESC-Labor für die Reserve-Geschichte (Headspeed, Übersetzung, Akku) an, bevor du Governor-Werte anfasst."
    });
  }

  if (
    collectiveDropEvents.length >= gate.MINIMUM_EVENTS &&
    powerLimitEvents.length === 0
  ) {
    const confidence =
      collectiveDropEvents.length >=
      gate.GOVERNOR_HIGH_CONFIDENCE_EVENTS
        ? "High"
        : "Medium";

    const huntingCount = collectiveDropEvents.filter(
      (event) => event.hunting
    ).length;

    const gated = confidence !== "High";

    recommendations.push({
      id: "governor:precomp-overshoot",
      lab: "governor",
      finding:
        `Der Rotor lief nach einem scharfen Kollektiv-Abfall auf ${collectiveDropEvents.length} Gelegenheiten über sein Ziel hinaus` +
        (huntingCount > 0
          ? `, ${huntingCount} davon pendelten danach um das Ziel`
          : "") +
        ".",
      hypothesis:
        "Überdrehzahl, die einem Kollektiv-Abfall folgt, ist die Governor-Vorsteuerung/Precomp, die noch Leistung einspeist, die die Last nicht mehr braucht. Weniger Kollektiv-Precomp fordert weniger davon an; mehr Governor-Dämpfung absorbiert es stattdessen. Zuerst die kleinere Änderung.",
      evidence: collectiveDropEvents.slice(0, 6).map((event) => ({
        kind: "governor-event",
        eventId: event.id,
        t: event.t,
        peakErrorPercent: event.peakErrorPercent,
        hunting: event.hunting
      })),
      evidenceCount: collectiveDropEvents.length,
      confidence,
      suggestion: gated
        ? null
        : {
            family: "gov_f_gain",
            direction: "down",
            magnitudeClass: "kleiner Schritt"
          },
      expectedResult: gated
        ? null
        : "Kollektiv-Abfälle erzeugen keine Über-Ziel-Ausreißer mehr, und die Ereignisse oben verschwinden von dieser Seite.",
      verifyMetric: gated
        ? null
        : "Über-Ziel-Ereignisse nach Kollektiv-Abfällen im Governor-Labor",
      gatedReason: gated
        ? `Zwei Vorkommen sind ein Hinweis, kein Muster (Sicherheit ${confidence}). Fliege ein weiteres Log mit denselben Bewegungen und lies diese Seite neu.`
        : null
    });
  }

  // ---- precomp balance (the ratio view) ----
  //
  // The event layer sees excursions past the fleet band; the ratio
  // view sees the systematic lean UNDER it. They agree by
  // construction (same error signal), so when the event-based
  // precomp recommendation already fired, the ratio adds nothing
  // and stays quiet.
  const governorBalance = precomp?.governor ?? null;
  const eventRecAlreadyFired = recommendations.some(
    (rec) => rec.id === "governor:precomp-overshoot"
  );

  if (
    governorBalance &&
    governorBalance.balance &&
    governorBalance.balance !== "balanced" &&
    powerLimitEvents.length === 0 &&
    !eventRecAlreadyFired
  ) {
    const sideCounts = `${governorBalance.riseCount} Anstiege / ${governorBalance.dropCount} Abfälle`;

    const confidence =
      governorBalance.riseCount >= 2 * gate.MINIMUM_EVENTS &&
      governorBalance.dropCount >= 2 * gate.MINIMUM_EVENTS
        ? "High"
        : "Medium";

    const gated = confidence !== "High";

    if (governorBalance.balance === "low") {
      recommendations.push({
        id: "governor:precomp-low",
        lab: "governor",
        finding: `Schnelle Kollektiv-Anstiege ziehen den Rotor um einen Median von ${governorBalance.riseDroopPercent} % unter das Ziel, während Abfälle sauber bleiben (${sideCounts} gemessen).`,
        hypothesis:
          "Droop, der nur beim Eintreffen der Last erscheint, ist Vorwegnahme, die hinterher hinkt: Der Governor wartet, den Fehler zu sehen, statt Leistung mit dem Kollektiv einzuspeisen. Mehr Kollektiv-Precomp fordert die Leistung an, bevor die Last es tut.",
        evidence: [
          {
            kind: "precomp-balance",
            riseDroopPercent: governorBalance.riseDroopPercent,
            dropOvershootPercent:
              governorBalance.dropOvershootPercent,
            riseCount: governorBalance.riseCount,
            dropCount: governorBalance.dropCount
          }
        ],
        confidence,
        suggestion: gated
          ? null
          : {
              family: "gov_f_gain",
              direction: "up",
              magnitudeClass: "kleiner Schritt"
            },
        expectedResult: gated
          ? null
          : "Der anstiegsseitige Droop im Precomp-Balance-Bericht schrumpft, ohne dass neue Überdrehzahl bei Abfällen erscheint.",
        verifyMetric: gated
          ? null
          : "die Anstiegs-Droop-Zahl im Precomp-Balance des Governor-Labors",
        gatedReason: gated
          ? `Noch nicht genug Kollektiv-Bewegungen in beide Richtungen (${sideCounts}). Fliege ein Log mit einigen ehrlichen Pumpen in jede Richtung und lies diese Seite neu.`
          : null
      });
    } else if (governorBalance.balance === "high") {
      recommendations.push({
        id: "governor:precomp-high",
        lab: "governor",
        finding: `Schnelle Kollektiv-Abfälle drücken den Rotor um einen Median von ${governorBalance.dropOvershootPercent} % über das Ziel, während Anstiege sauber bleiben (${sideCounts} gemessen).`,
        hypothesis:
          "Überdrehzahl, die nur beim Abgehen der Last erscheint, ist Vorwegnahme, die zu weit schießt: Der Precomp speist weiter Leistung ein, die die Last nicht mehr braucht. Weniger Kollektiv-Precomp, oder mehr Governor-Dämpfung, absorbiert es. Zuerst die kleinere Änderung.",
        evidence: [
          {
            kind: "precomp-balance",
            riseDroopPercent: governorBalance.riseDroopPercent,
            dropOvershootPercent:
              governorBalance.dropOvershootPercent,
            riseCount: governorBalance.riseCount,
            dropCount: governorBalance.dropCount
          }
        ],
        confidence,
        suggestion: gated
          ? null
          : {
              family: "gov_f_gain",
              direction: "down",
              magnitudeClass: "kleiner Schritt"
            },
        expectedResult: gated
          ? null
          : "Die abfallseitige Überdrehzahl im Precomp-Balance-Bericht schrumpft, ohne dass neuer Droop bei Anstiegen erscheint.",
        verifyMetric: gated
          ? null
          : "die Abfall-Überdrehzahl-Zahl im Precomp-Balance des Governor-Labors",
        gatedReason: gated
          ? `Noch nicht genug Kollektiv-Bewegungen in beide Richtungen (${sideCounts}). Fliege ein Log mit einigen ehrlichen Pumpen in jede Richtung und lies diese Seite neu.`
          : null
      });
    } else if (governorBalance.balance === "lagging") {
      recommendations.push({
        id: "governor:response-lag",
        lab: "governor",
        finding: `Der Rotor verfehlt sein Ziel in beide Richtungen bei Kollektiv-Bewegungen: Droop ${governorBalance.riseDroopPercent} % bei Anstiegen UND Überdrehzahl ${governorBalance.dropOvershootPercent} % bei Abfällen (${sideCounts} gemessen).`,
        hypothesis:
          "In beide Richtungen zu verfehlen ist kein Precomp-Balance-Problem: Precomp tauscht eine Seite gegen die andere. Ein Governor, der in beide Richtungen spät ist, ist ein Antwortgeschwindigkeits-Thema, das in seinem Gain und der Leistungsreserve des Antriebssystems zusammen liegt.",
        evidence: [
          {
            kind: "precomp-balance",
            riseDroopPercent: governorBalance.riseDroopPercent,
            dropOvershootPercent:
              governorBalance.dropOvershootPercent,
            riseCount: governorBalance.riseCount,
            dropCount: governorBalance.dropCount
          }
        ],
        confidence,
        suggestion: null,
        expectedResult: null,
        verifyMetric: null,
        gatedReason:
          "Zweiseitiger Lag braucht den Leistungsreserve-Bericht des ESC-Labors daneben, bevor ein Governor-Wert bewegt wird. Diese Seite zuerst prüfen."
      });
    }
  }

  // ---- tail precomp coupling ----
  const tailBalance = precomp?.tail ?? null;

  if (tailBalance?.balance === "coupled") {
    recommendations.push({
      id: "governor:tail-coupling",
      lab: "governor",
      finding: `Kollektiv-Bewegungen kicken das Heck ${tailBalance.kickRatio}× stärker als seinen gewöhnlichen Fehler (Median ${tailBalance.transientError} °/s über ${tailBalance.kickCount} Bewegungen, ${Math.round(tailBalance.consistency * 100)} % in einer konsistenten Richtung).`,
      hypothesis:
        "Ein Heck, das sich nur bei Kollektiv-Transienten falsch verhält, ist Drehmoment-Vorwegnahme, kein Heck-Tuning: Der Kollektiv-Feedforward in Gier passt nicht zur Drehmomentänderung. Der Regler ist der Kollektiv-zu-Gier-Precomp. Aber seine Richtung hängt von der Rotordrehung ab, die ein Log nicht angibt.",
      evidence: [
        {
          kind: "tail-coupling",
          kickRatio: tailBalance.kickRatio,
          transientError: tailBalance.transientError,
          consistency: tailBalance.consistency,
          kickCount: tailBalance.kickCount
        }
      ],
      confidence:
        tailBalance.kickCount >= 2 * gate.MINIMUM_EVENTS
          ? "Hoch"
          : "Mittel",
      suggestion: null,
      expectedResult: null,
      verifyMetric: null,
      gatedReason:
        "yaw_collective_ff_gain einen kleinen Schritt in eine Richtung verstellen und dieselben Pumps fliegen: Wenn der Kick wächst, die andere Richtung wählen. Der Precomp-Balance-Bericht hier ist der Vorher/Nachher-Richter."
    });
  }

  return recommendations.map(silenceForVibration);
}
