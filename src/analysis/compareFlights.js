// ======================================================
// BLACKBOX LAB — BEFORE / AFTER COMPARISON
// ======================================================
//
// The payoff of the tuning loop, in one sentence per
// topic: "your change cut the 137 Hz tail peak by 62%".
//
// Takes two analyzed datasets (baseline = before,
// comparison = after) and returns plain-language delta
// rows, each marked better / worse / same.
//
// ======================================================

import { demandSignature, compareDemand } from "./demandSignature.js";

function strongestPeak(spectra) {
  if (!spectra || spectra.length === 0) {
    return null;
  }

  let peakHz = 0;
  let peakMagnitude = 0;

  for (const { spectrum } of spectra) {
    for (let i = 0; i < spectrum.frequencies.length; i += 1) {
      if (
        spectrum.frequencies[i] > 10 &&
        spectrum.magnitudes[i] > peakMagnitude
      ) {
        peakMagnitude = spectrum.magnitudes[i];
        peakHz = spectrum.frequencies[i];
      }
    }
  }

  return peakMagnitude > 0 ? { hz: peakHz, magnitude: peakMagnitude } : null;
}

function percentChange(before, after) {
  if (!Number.isFinite(before) || before === 0) {
    return null;
  }

  return ((after - before) / Math.abs(before)) * 100;
}

function describeChange(before, after, lowerIsBetter, minimumDelta) {
  const absoluteDelta = after - before;

  // Tiny absolute changes are noise, not news — a droop of
  // 4 vs 6 rpm is "excellent both times", not "50% worse".
  if (
    !Number.isFinite(absoluteDelta) ||
    Math.abs(absoluteDelta) < minimumDelta
  ) {
    return { direction: "same", word: "etwa gleich" };
  }

  // A zero baseline has no percent — but 0 → 8 is not "the same".
  // The common good state IS zero (no excursions, no events), so
  // regressions from it must be called what they are.
  if (before === 0) {
    const improved = lowerIsBetter ? after < 0 : after > 0;
    return {
      direction: improved ? "better" : "worse",
      word: improved ? "besser" : "schlechter"
    };
  }

  const change = percentChange(before, after);

  if (change === null || Math.abs(change) < 5) {
    return { direction: "same", word: "etwa gleich" };
  }

  const improved = lowerIsBetter ? change < 0 : change > 0;

  return {
    direction: improved ? "better" : "worse",
    word: `${Math.abs(change).toFixed(0)}% ${improved ? "besser" : "schlechter"}`
  };
}

/**
 * Whether two tracking scores rest on enough evidence to be subtracted
 * from one another.
 *
 * A flight with almost no clean command responses still produces a
 * score; comparing it with a well-flown one measures how much each was
 * measured, not how each flew.
 */
export function comparableEvidence(beforeConfidence, afterConfidence) {
  const thin = (confidence) =>
    confidence?.level === "Low" || confidence?.level === "Insufficient";

  const beforeThin = thin(beforeConfidence);
  const afterThin = thin(afterConfidence);

  // Same-demand flights only: a hover-level score and a
  // maneuvering score are different measurements wearing the same
  // number, and subtracting them ranks the flying style, not the
  // change. (This is how a mis-set-up machine hovering calmly
  // "outscored" its own fixed self on a sport flight.)
  const beforeDemand = beforeConfidence?.demand ?? null;
  const afterDemand = afterConfidence?.demand ?? null;

  if (
    beforeDemand &&
    afterDemand &&
    beforeDemand !== afterDemand
  ) {
    return {
      comparable: false,
      reason:
        beforeDemand === "gentle"
          ? "der frühere Flug wurde sanft geflogen, während der spätere deutlich härter geflogen wurde. Die beiden Punktzahlen messen unterschiedliche Anforderungen, nicht die Änderung."
          : "der spätere Flug wurde sanft geflogen, während der frühere deutlich härter geflogen wurde. Die beiden Punktzahlen messen unterschiedliche Anforderungen, nicht die Änderung."
    };
  }

  if (!beforeThin && !afterThin) {
    return { comparable: true, reason: "" };
  }

  if (beforeThin && afterThin) {
    return {
      comparable: false,
      reason: "keiner der Flüge hat genug saubere Stick-Bewegungen aufgezeichnet, um daran die Nachführung zu messen."
    };
  }

  return {
    comparable: false,
    reason: beforeThin
      ? "der frühere Flug hat nicht genug saubere Stick-Bewegungen aufgezeichnet, um daran die Nachführung zu messen."
      : "der spätere Flug hat nicht genug saubere Stick-Bewegungen aufgezeichnet, um daran die Nachführung zu messen."
  };
}

/**
 * Are these two flights the same helicopter?
 *
 * Comparing a change means holding the machine still and varying one
 * thing. Two different helicopters differ in every way at once, so the
 * numbers are worth showing but the difference is not a verdict on
 * anything the pilot did.
 *
 * Unknown names are treated as the same aircraft: a log without a
 * craft name is common, and refusing to compare on that basis would
 * take a working feature away from the pilots most likely to need it.
 */
export function sameAircraft(beforeCraft, afterCraft) {
  const clean = (name) => {
    const text = String(name ?? "").trim();
    return !text || text === "Not found" || text === "Unknown craft"
      ? null
      : text.toLowerCase();
  };

  const before = clean(beforeCraft);
  const after = clean(afterCraft);

  if (!before || !after) {
    return { known: false, same: true, before, after };
  }

  return { known: true, same: before === after, before, after };
}


// ------------------------------------------------------
// Setup comparison — what actually CHANGED between the
// two flights, read from the logged FC settings.
// ------------------------------------------------------
//
// "Your change helped" presumes there was one change. The BBL
// header logs the full tuning state, so the pair can be told
// apart honestly: no change logged, one named change, or several
// changes that no single verdict may take credit for.

const COMPARABLE_SETUP_KEYS = [
  "rollPID", "pitchPID", "yawPID", "levelPID", "govPID",
  "rates_type", "rc_rates", "rates",
  "yaw_stop_gain", "yaw_precomp", "yaw_inertia_precomp",
  "hsi_gain", "hsi_limit",
  "gyro_lpf1_type", "gyro_lpf1_static_hz", "gyro_lpf1_dyn_hz",
  "gyro_lpf2_type", "gyro_lpf2_static_hz",
  "gyro_notch_hz", "gyro_notch_cutoff",
  "gyro_rpm_notch_preset", "gyro_rpm_notch_min_hz",
  "dterm_lpf1_type", "dterm_lpf1_static_hz",
  "dterm_lpf2_type", "dterm_lpf2_static_hz"
];

export function extractComparableSetup(lines) {
  if (!Array.isArray(lines)) {
    return null;
  }

  const settings = {};
  let startIso = null;
  let found = 0;

  for (const line of lines) {
    if (typeof line !== "string" || line[0] !== '"') continue;
    const match = line.match(/^"([^"]+)","(.*)"$/);
    if (!match) continue;
    if (match[1] === "Log start datetime") {
      startIso = match[2];
    } else if (COMPARABLE_SETUP_KEYS.includes(match[1])) {
      settings[match[1]] = match[2];
      found += 1;
    }
  }

  return { settings, startIso, found };
}

export function diffSetups(before, after) {
  if (!before || !after || before.found === 0 || after.found === 0) {
    return null;
  }

  const changedKeys = [];
  for (const key of COMPARABLE_SETUP_KEYS) {
    const a = before.settings[key];
    const b = after.settings[key];
    if (a !== undefined && b !== undefined && a !== b) {
      changedKeys.push(key);
    }
  }

  return { changedKeys, changedCount: changedKeys.length };
}

// A start timestamp is only trustworthy when the FC clock was
// actually set: unsynced RTCs log epoch-adjacent years. Equal or
// unusable stamps mean: preserve the user's order, never guess.
export function chronologicalOrder(startIsoA, startIsoB) {
  const parse = (iso) => {
    const ms = Date.parse(iso ?? "");
    if (!Number.isFinite(ms)) return null;
    const year = new Date(ms).getUTCFullYear();
    return year >= 2010 ? ms : null;
  };

  const a = parse(startIsoA);
  const b = parse(startIsoB);

  if (a === null || b === null || a === b) {
    return null;
  }

  return a <= b ? "keep" : "swap";
}

/**
 * Can these two flights carry a before/after conclusion at all?
 * Exposed BEFORE any improvement wording (#32): flight-to-flight
 * variation can be as large as a tuning change, so the comparison
 * states what evidence it stands on — demand match, per-axis clean
 * command counts on both sides, duration balance, and both scores'
 * evidence strength — and downgrades its own language when the
 * footing is weak.
 */
export function assessComparability(baseline, comparison) {
  const lines = [];
  let level = "comparable";
  const demote = (to) => {
    if (to === "weak" || level === "weak") level = to === "weak" ? "weak" : level;
    else level = "partial";
  };

  const beforeDemand = baseline?.pidConfidence?.demand ?? null;
  const afterDemand = comparison?.pidConfidence?.demand ?? null;
  if (beforeDemand && afterDemand) {
    if (beforeDemand === afterDemand) {
      lines.push(`Flug-Anforderung: vergleichbar (beide ${beforeDemand === "gentle" ? "sanft" : "mit echten Eingaben"} geflogen).`);
    } else {
      lines.push("Flug-Anforderung: NICHT vergleichbar — ein Flug wurde sanft geflogen, der andere deutlich härter. Die Messungen beschreiben unterschiedliches Fliegen, nicht die Änderung.");
      demote("weak");
    }
  }

  const thin = (confidence) =>
    confidence?.level === "Low" || confidence?.level === "Insufficient";
  const beforeThin = thin(baseline?.pidConfidence);
  const afterThin = thin(comparison?.pidConfidence);
  if (beforeThin || afterThin) {
    lines.push(
      `Beleg-Stärke: ${beforeThin && afterThin ? "beide Flüge sind" : beforeThin ? "der frühere Flug ist" : "der spätere Flug ist"} dünn an sauberen Kommando-Antworten.`
    );
    demote(beforeThin && afterThin ? "weak" : "partial");
  }

  const axes = new Set([
    ...Object.keys(baseline?.axisEvidence ?? {}),
    ...Object.keys(comparison?.axisEvidence ?? {})
  ]);
  const axisLines = [];
  let comparableAxes = 0;
  for (const axis of axes) {
    const before = baseline?.axisEvidence?.[axis] ?? 0;
    const after = comparison?.axisEvidence?.[axis] ?? 0;
    const ok = before >= 8 && after >= 8;
    if (ok) comparableAxes += 1;
    axisLines.push(`${axis} ${before} gegen ${after}${ok ? "" : " (zu wenige auf einer Seite)"}`);
  }
  if (axisLines.length > 0) {
    lines.push(`Saubere Kommando-Ereignisse pro Achse (vorher gegen nachher): ${axisLines.join("; ")}.`);
    if (comparableAxes === 0) demote("weak");
    else if (comparableAxes < axes.size) demote("partial");
  }

  const durationOf = (dataset) => {
    const t = dataset?.timeSeconds;
    return Array.isArray(t) && t.length ? t[t.length - 1] : null;
  };
  const beforeDuration = durationOf(baseline);
  const afterDuration = durationOf(comparison);
  if (Number.isFinite(beforeDuration) && Number.isFinite(afterDuration) && beforeDuration > 0 && afterDuration > 0) {
    const ratio = Math.min(beforeDuration, afterDuration) / Math.max(beforeDuration, afterDuration);
    if (ratio < 0.4) {
      lines.push(`Flugdauer: unausgewogen (${Math.round(beforeDuration)} s gegen ${Math.round(afterDuration)} s) — der längere Flug hatte schlicht mehr Gelegenheiten, Ereignisse zu zeigen.`);
      demote("partial");
    }
  }

  // The demand signature (#38 / preview #32): every dimension the two
  // flights can differ on, side by side, with the verdict confidence
  // it leaves. The weaker of the two rulings governs the wording.
  const demand = compareDemand(
    demandSignature(baseline),
    demandSignature(comparison)
  );
  const rank = { weak: 0, partial: 1, comparable: 2 };
  if (rank[demand.level] < rank[level]) level = demand.level;

  return {
    level,
    causal: level === "comparable",
    lines,
    rows: demand.rows,
    confidence: demand.confidence,
    reducedBy: demand.reducedBy,
    guidance:
      level === "comparable"
        ? null
        : "Behandle die Unterschiede unten als Beobachtungen, nicht als Beweis für eine Tuning-Änderung. Wiederhole dieselben Manöver bei derselben Headspeed, um sie zu bestätigen."
  };
}

export function compareFlights(baseline, comparison, options = {}) {
  const rows = [];
  const comparability = assessComparability(baseline, comparison);
  const causally = (causalSentence, neutralSentence) =>
    comparability.causal ? causalSentence : neutralSentence;

  // ---- vibration ----
  const peakBefore = strongestPeak(baseline.spectra);
  const peakAfter = strongestPeak(comparison.spectra);

  if (peakBefore && peakAfter) {
    const described = describeChange(
      peakBefore.magnitude,
      peakAfter.magnitude,
      true,
      1.5
    );

    rows.push({
      title: "Vibration",
      direction: described.direction,
      before: `${peakBefore.magnitude.toFixed(1)} @ ${peakBefore.hz.toFixed(0)} Hz`,
      after: `${peakAfter.magnitude.toFixed(1)} @ ${peakAfter.hz.toFixed(0)} Hz`,
      sentence:
        described.direction === "same"
          ? `Die größte Vibrationsspitze ist etwa gleich (${peakAfter.magnitude.toFixed(1)} bei ${peakAfter.hz.toFixed(0)} Hz).`
          : causally(
              `Deine Änderung hat die größte Vibrationsspitze ${described.word} gemacht: ${peakBefore.magnitude.toFixed(1)} → ${peakAfter.magnitude.toFixed(1)} bei ~${peakAfter.hz.toFixed(0)} Hz.`,
              `Die größte Vibrationsspitze wurde im späteren Flug ${described.word} gemessen: ${peakBefore.magnitude.toFixed(1)} → ${peakAfter.magnitude.toFixed(1)} bei ~${peakAfter.hz.toFixed(0)} Hz.`
            )
    });
  }

  // ---- governor droop ----
  const govBefore = baseline.labs?.governor;
  const govAfter = comparison.labs?.governor;

  if (govBefore && govAfter) {
    const droopBefore = govBefore.droopRpm;
    const droopAfter = govAfter.droopRpm;
    const described = describeChange(
      droopBefore,
      droopAfter,
      true,
      8
    );

    // "Droop" is a target-relative word. If either flight lacks a
    // governor target, the number being compared is a short-term
    // swing against the rotor's own trend, and the row says so.
    const bothMeasuredDroop =
      govBefore.capability === "full" &&
      govAfter.capability === "full";

    const measureWord = bothMeasuredDroop
      ? "schlimmster Droop"
      : "größte Schwankung";

    rows.push({
      title: "Headspeed-Halten",
      direction: described.direction,
      before: `${Math.round(droopBefore)} U/min ${measureWord}`,
      after: `${Math.round(droopAfter)} U/min ${measureWord}`,
      sentence:
        described.direction === "same"
          ? `${bothMeasuredDroop ? "Governor-Halten" : "Headspeed-Gleichmäßigkeit"} ist etwa gleich (${measureWord} ${Math.round(droopAfter)} U/min).`
          : `${bothMeasuredDroop ? "Das Headspeed-Halten" : "Die Headspeed-Gleichmäßigkeit"} wurde ${described.word}: ${measureWord} ${Math.round(droopBefore)} → ${Math.round(droopAfter)} U/min.`
    });
  }

  // ---- tracking score ----
  const scoreBefore = baseline.pidScore;
  const scoreAfter = comparison.pidScore;

  if (Number.isFinite(scoreBefore) && Number.isFinite(scoreAfter)) {
    // A tracking score is only as solid as the clean command responses
    // it was measured from. Subtracting a well-evidenced score from a
    // barely-evidenced one produces a confident-looking number that
    // describes the evidence gap, not the flying — so where either
    // side is thin, the difference is reported and left uncounted
    // rather than called better or worse.
    const evidence = comparableEvidence(
      baseline.pidConfidence,
      comparison.pidConfidence
    );

    if (evidence.comparable) {
      const described = describeChange(
        scoreBefore,
        scoreAfter,
        false,
        5
      );

      rows.push({
        title: "Nachführung",
        direction: described.direction,
        before: `${scoreBefore}/100`,
        after: `${scoreAfter}/100`,
        sentence:
          described.direction === "same"
            ? `Die Stick-Nachführung ist etwa gleich (${scoreAfter}/100).`
            : `Die Stick-Nachführung wurde ${described.word}: ${scoreBefore} → ${scoreAfter} Punkte.`
      });
    } else {
      rows.push({
        title: "Nachführung",
        direction: "unknown",
        before: `${scoreBefore}/100`,
        after: `${scoreAfter}/100`,
        sentence: `Die Nachführung lässt sich hier nicht vergleichen: ${evidence.reason} Beide Zahlen werden gezeigt, aber der Unterschied zwischen ihnen hätte keine Aussagekraft.`
      });
    }
  }

  // ---- stick response events ----
  //
  // The recommendation cards name "the slow-settle count" and "the
  // overshoot count in Flight Events" as their verify metric — this
  // row is where that promise is kept. Counts are compared as a
  // RATE per measured command: two flights rarely contain the same
  // number of stick inputs, and 3-of-40 versus 3-of-8 are different
  // machines.
  const eventsBefore = baseline.flightEvents?.summary;
  const eventsAfter = comparison.flightEvents?.summary;

  if (eventsBefore?.total > 0 && eventsAfter?.total > 0) {
    const reviewBefore =
      eventsBefore.overshoot +
      eventsBefore.slow +
      (eventsBefore.lagging ?? 0) +
      (eventsBefore.oscillation ?? 0);
    const reviewAfter =
      eventsAfter.overshoot +
      eventsAfter.slow +
      (eventsAfter.lagging ?? 0) +
      (eventsAfter.oscillation ?? 0);

    const rateBefore = reviewBefore / eventsBefore.total;
    const rateAfter = reviewAfter / eventsAfter.total;

    // The DIRECTION comes from the rate (two flights rarely hold
    // the same number of commands), but the noise floor is one
    // whole event: a rate wiggle without a count change is nothing.
    const described =
      Math.abs(reviewAfter - reviewBefore) < 1
        ? { direction: "same", word: "etwa gleich" }
        : describeChange(rateBefore, rateAfter, true, 0.001);

    const describeSide = (summary, review) =>
      `${review} von ${summary.total} Kommando${summary.total === 1 ? "" : "s"}` +
      (review > 0
        ? ` (${summary.overshoot} überschwungen · ${summary.slow} langsam` +
          ((summary.oscillation ?? 0) > 0
            ? ` · ${summary.oscillation} geschwungen`
            : "") +
          ((summary.lagging ?? 0) > 0
            ? ` · ${summary.lagging} spät`
            : "") +
          `)`
        : "");

    rows.push({
      title: "Stick-Antwort-Ereignisse",
      direction: described.direction,
      before: describeSide(eventsBefore, reviewBefore),
      after: describeSide(eventsAfter, reviewAfter),
      sentence:
        reviewBefore === 0 && reviewAfter === 0
          ? "Jedes gemessene Stick-Kommando wurde in beiden Flügen sauber nachgeführt."
          : described.direction === "same"
            ? `Der Anteil der Kommandos, die geprüft werden müssen, ist etwa gleich (${reviewAfter} von ${eventsAfter.total}).`
            : `Der Anteil der Kommandos, die geprüft werden müssen, wurde ${described.word}: ${reviewBefore} von ${eventsBefore.total} → ${reviewAfter} von ${eventsAfter.total}.`
    });
  }

  // ---- governor excursions ----
  const govExBefore = baseline.governorEvents?.summary;
  const govExAfter = comparison.governorEvents?.summary;

  if (govExBefore && govExAfter) {
    const countBefore = govExBefore.totalFound;
    const countAfter = govExAfter.totalFound;

    const described = describeChange(
      countBefore,
      countAfter,
      true,
      1
    );

    const describeSide = (summary, count) =>
      count === 0
        ? "keine"
        : `${count} (${summary.under} darunter · ${summary.over} darüber)`;

    rows.push({
      title: "Headspeed-Abweichungen",
      direction:
        countBefore === 0 && countAfter === 0
          ? "same"
          : described.direction,
      before: describeSide(govExBefore, countBefore),
      after: describeSide(govExAfter, countAfter),
      sentence:
        countBefore === 0 && countAfter === 0
          ? "Der Rotor blieb in beiden Flügen innerhalb des Ereignisbands."
          : described.direction === "same"
            ? `Die Headspeed-Abweichungen sind etwa gleich (${countAfter}).`
            : `Die Headspeed-Abweichungen wurden ${described.word}: ${countBefore} → ${countAfter}.`
    });
  }

  // ---- precomp balance ----
  //
  // The precomp recommendations name these exact numbers as their
  // before/after judge. Each side must have READ a balance (enough
  // collective moves both ways) for the row to appear.
  const precompRows = [
    {
      key: "riseDroopPercent",
      title: "Droop bei Kollektiv-Anstieg",
      unit: "%",
      minimumDelta: 1
    },
    {
      key: "dropOvershootPercent",
      title: "Überdrehzahl bei Kollektiv-Abfall",
      unit: "%",
      minimumDelta: 1
    }
  ];

  for (const { key, title, unit, minimumDelta } of precompRows) {
    const valueBefore = baseline.precomp?.governor?.[key];
    const valueAfter = comparison.precomp?.governor?.[key];

    if (!Number.isFinite(valueBefore) || !Number.isFinite(valueAfter)) {
      continue;
    }

    const described = describeChange(
      valueBefore,
      valueAfter,
      true,
      minimumDelta
    );

    rows.push({
      title,
      direction: described.direction,
      before: `${valueBefore}${unit}`,
      after: `${valueAfter}${unit}`,
      sentence:
        described.direction === "same"
          ? `${title} ist etwa gleich (${valueAfter}${unit}).`
          : `${title} wurde ${described.word}: ${valueBefore}${unit} → ${valueAfter}${unit}.`
    });
  }

  const kickBefore = baseline.precomp?.tail?.kickRatio;
  const kickAfter = comparison.precomp?.tail?.kickRatio;

  if (Number.isFinite(kickBefore) && Number.isFinite(kickAfter)) {
    const described = describeChange(
      kickBefore,
      kickAfter,
      true,
      0.8
    );

    rows.push({
      title: "Heck-Kick bei Kollektiv-Bewegungen",
      direction: described.direction,
      before: `${kickBefore}× Basislinie`,
      after: `${kickAfter}× Basislinie`,
      sentence:
        described.direction === "same"
          ? `Die Reaktion des Hecks auf Kollektiv-Bewegungen ist etwa gleich (${kickAfter}× seines Basisfehlers).`
          : `Die Reaktion des Hecks auf Kollektiv-Bewegungen wurde ${described.word}: ${kickBefore}× → ${kickAfter}× seines Basisfehlers.`
    });
  }

  // ---- battery sag ----
  const sagBefore = baseline.batterySagPercent;
  const sagAfter = comparison.batterySagPercent;

  if (Number.isFinite(sagBefore) && Number.isFinite(sagAfter)) {
    const described = describeChange(
      sagBefore,
      sagAfter,
      true,
      1.5
    );

    rows.push({
      title: "Akku-Einbruch",
      direction: described.direction,
      before: `${sagBefore.toFixed(1)}%`,
      after: `${sagAfter.toFixed(1)}%`,
      sentence:
        described.direction === "same"
          ? `Der Akku-Einbruch ist etwa gleich (${sagAfter.toFixed(1)} %).`
          : `Der Akku-Einbruch wurde ${described.word}: ${sagBefore.toFixed(1)} % → ${sagAfter.toFixed(1)} %.`
    });
  }

  const better = rows.filter((row) => row.direction === "better").length;
  const worse = rows.filter((row) => row.direction === "worse").length;
  const uncomparable = rows.filter(
    (row) => row.direction === "unknown"
  ).length;

  // "Consider reverting it" tells a pilot to undo work. It has to rest
  // on something measured on both sides — with nothing comparable to
  // count, the honest answer is that this pair does not answer the
  // question, not a direction to act on. The same applies when the two
  // flights are different helicopters: every number will differ, and
  // none of it is a verdict on a change.
  const comparedRows = better + worse;
  const aircraft = sameAircraft(baseline.craftName, comparison.craftName);

  // ---- comparability gate for the causal headline ----
  // "That's a keeper" and "consider reverting" recommend keeping or
  // undoing a setup change — causal claims. The rows above only
  // DESCRIBE differences; attributing them to the change needs the
  // pair to be like-for-like: same machine, matched flight demand,
  // and solid evidence on both sides. Below that bar the summary
  // stays descriptive and asks for the confirming flight instead of
  // recommending action.
  const setupDiff = options.setupDiff ?? null;

  const headlineEvidence = comparableEvidence(
    baseline.pidConfidence,
    comparison.pidConfidence
  );
  const evidenceKnown =
    Boolean(baseline.pidConfidence) && Boolean(comparison.pidConfidence);
  const likeForLike =
    aircraft.same &&
    evidenceKnown &&
    headlineEvidence.comparable &&
    comparability.causal;
  const unlikeReason = !aircraft.same
    ? ""
    : !evidenceKnown
      ? "dieses Paar trägt nicht genug Beleg, um zu bestätigen, dass beide Flüge gleich geflogen wurden."
      : !headlineEvidence.comparable
        ? headlineEvidence.reason
        : comparability.causal
          ? ""
          : "die Anforderung oder die Belege je Achse der Flüge waren nur teilweise vergleichbar (das Vergleichbarkeits-Panel oben hat die Details).";

  // Different helicopters: the numbers are shown for reference, but
  // "90% better" is a tuning judgment and there is no tune being
  // judged — every row becomes descriptive, not directional.
  if (!aircraft.same) {
    for (const row of rows) {
      row.direction = "unknown";
      row.sentence = `${row.title}: ${row.before} gegen ${row.after}. Zwei verschiedene Maschinen, nur zur Orientierung nebeneinander gezeigt.`;
    }
  }

  const summary =
    rows.length === 0
      ? "Nicht genug gemeinsame Daten zwischen den beiden Flügen zum Vergleichen."
      : !aircraft.same
        ? `Diese Flüge sind verschiedene Helikopter (${aircraft.before} und ${aircraft.after}), die Zahlen unten beschreiben also zwei Maschinen und nicht eine Änderung an einer.`
        : comparedRows === 0
          ? uncomparable > 0
            ? "Diese beiden Flüge lassen sich nicht sinnvoll vergleichen: Siehe die Zeilen unten, was fehlte."
            : "Keine bedeutsame Änderung zwischen diesen beiden Flügen."
          : worse === 0 && better > 0
            ? likeForLike
              ? setupDiff && setupDiff.changedCount === 0
                ? "Der spätere Flug maß besser, OHNE dass zwischen beiden eine Einstellungsänderung geloggt wurde: Der Unterschied spiegelt Bedingungen oder Fliegen wider, kein Tuning. Nichts zu behalten oder zurückzunehmen."
                : setupDiff && setupDiff.changedCount === 1
                  ? `Deine Änderung hat geholfen: Nichts wurde schlechter, und die Logs zeigen genau eine Einstellungsänderung (${setupDiff.changedKeys[0]}). Das ist ein Treffer.`
                  : setupDiff && setupDiff.changedCount > 1
                    ? `Der spätere Flug maß besser und nichts wurde schlechter, und zwischen diesen Flügen haben sich ${setupDiff.changedCount} Einstellungen geändert (${setupDiff.changedKeys.slice(0, 3).join(", ")}${setupDiff.changedCount > 3 ? ", …" : ""}). Der Gewinn gehört dem ganzen Satz: Die eigene Prüfmetrik jeder Änderung — der Paket-Check führt diese bei Paket-Änderungen automatisch aus — sagt, welches Mitglied ihn verdient hat.`
                    : "Deine Änderung hat geholfen: Nichts wurde schlechter. Das ist ein Treffer."
              : `Der spätere Flug maß in ${better} Bereich${better === 1 ? "" : "en"} besser und nichts Gemessenes wurde schlechter. Ob das deine Änderung ist oder ein unterschiedliches Fliegen, ist noch nicht geklärt: ${unlikeReason} Wiederhole dieselben Manöver; kehrt der Gewinn zurück, ist es ein Treffer.`
            : better === 0 && worse > 0
              ? likeForLike
                ? "Diese Änderung ging in die falsche Richtung. Erwäge, sie zurückzunehmen."
                : `Der spätere Flug maß in ${worse} Bereich${worse === 1 ? "" : "en"} schlechter, aber ${unlikeReason} Wiederhole dieselben Manöver, bevor du etwas zurücknimmst.`
              : likeForLike
                ? "Gemischtes Ergebnis: Manches hat sich verbessert, anderes wurde schlechter. Abwägungs-Gebiet."
                : `Die Messwerte bewegten sich in beide Richtungen, und ${unlikeReason} Dieses Paar liest sich mehr wie zwei verschiedene Flüge als wie eine Änderung; wiederhole dieselben Manöver für ein klareres Urteil.`;

  // Better/worse is a JUDGMENT, and a weak footing cannot carry one
  // (#38): when the pair is not causal, directional rows keep their
  // numbers but are displayed as observations — the badge, the color
  // and the report all inherit this flag.
  if (aircraft.same && !comparability.causal) {
    for (const row of rows) {
      if (row.direction === "better" || row.direction === "worse") {
        row.gated = true;
      }
    }
  }

  // The verdict names the confidence it carries, and what lowered it,
  // in the same sentence the pilot reads first.
  const confidenceSentence =
    comparability.confidence && rows.length > 0 && aircraft.same
      ? ` Urteils-Sicherheit: ${comparability.confidence}${ comparability.reducedBy?.length ? ` — reduziert durch ${comparability.reducedBy.join(", ")}` : "" }.`
      : "";

  return {
    rows,
    summary: summary + confidenceSentence,
    // The footing (rows, confidence, level, lines) AND the causal
    // gate (likeForLike, reason) — one object. A second key of the
    // same name used to overwrite the first here, which is why the
    // comparability panel never showed on the page.
    comparability: { ...comparability, likeForLike, reason: unlikeReason },
    better,
    worse,
    uncomparable,
    sameAircraft: aircraft.same,
    setupDiff
  };
}
