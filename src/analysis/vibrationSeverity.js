// ======================================================
// BLACKBOX LAB — VIBRATION CONCLUSION LAYER
// ======================================================
//
// The detector's job is to see everything; this layer's
// job is to say only what the evidence proves. Four
// separate concepts, never blended:
//
//   1. Detected      — what was measured, an observation
//   2. Filtering     — what Rotorflight does with it
//   3. Control impact — does it reach the control loop
//   4. Recommendation — only then, what to do
//
// Severity climbs Observed → Worth reviewing → Suspected
// mechanical source → Strong evidence, and the strong
// steps require MULTIPLE agreeing signals. A cleanly
// filtered expected harmonic with no control-loop impact
// is a managed observation, not a fault — the state
// between "no vibration" and "mechanical problem".
//
// ======================================================

// Raw-amplitude bands (unchanged from the fleet-calibrated
// verdict): above STRONG the shake is big by any standard,
// above MODERATE it is worth words at all.
const RAW_STRONG = 8;
const RAW_MODERATE = 3;

// Filtering counts as managing a peak when it removes at
// least this share of it and what remains is small.
const MANAGED_REDUCTION_PERCENT = 90;
const RESIDUAL_QUIET = 1.5;

// A residual this big reaches the control loop regardless
// of how good the percentage sounds.
const RESIDUAL_LOUD = 3;

/**
 * @param {object} evidence {
 *   rawMagnitude, hz, source,      // detection (source = hypothesis text)
 *   reductionPercent,              // measured attenuation, null = unknown
 *   residualMagnitude,             // filtered peak, null = unknown
 *   trackingConcern                // control evidence from PID lab, null = unknown
 * }
 * @returns {object} {
 *   level: "observed" | "review" | "suspected" | "strong",
 *   managed,                       // filtering demonstrably handles it
 *   controlImpact,                 // true / false / null (unknown)
 *   detected, filtering, impact, recommendation   // the four sentences
 * }
 */
export function assessVibrationConclusion({
  rawMagnitude,
  hz,
  source,
  reductionPercent = null,
  residualMagnitude = null,
  trackingConcern = null
}) {
  const raw = Number(rawMagnitude);
  const hzLabel = Number.isFinite(hz) ? Number(hz).toFixed(0) : "?";

  const filteringKnown =
    Number.isFinite(reductionPercent) &&
    Number.isFinite(residualMagnitude);

  const managed =
    filteringKnown &&
    reductionPercent >= MANAGED_REDUCTION_PERCENT &&
    residualMagnitude < RESIDUAL_QUIET;

  const controlImpact = filteringKnown
    ? residualMagnitude >= RESIDUAL_LOUD || trackingConcern === true
    : trackingConcern === true
      ? true
      : null;

  // ---- the four sentences ----

  const detected = `Vibration bei ${hzLabel} Hz erkannt (Rohbetrag ${raw.toFixed(1)}). Frequenzgebiet: ${source}. Das ist eine Beobachtung, keine Diagnose.`;

  const filtering = filteringKnown
    ? `Rotorflight-Filterung reduziert diese Spitze um ${Math.round(reductionPercent)} % (${raw.toFixed(1)} roh → ${residualMagnitude.toFixed(1)} gefiltert).`
    : "Dieses Log enthält keine separate gefilterte Gyro-Kurve, deshalb lässt sich die Filterwirkung an dieser Spitze nicht messen.";

  const impact =
    controlImpact === true
      ? "Restliche Vibration erreicht den gefilterten Gyro und beeinflusst möglicherweise die Steuerantwort."
      : controlImpact === false
        ? "Keine nennenswerte Auswirkung auf gefilterten Gyro oder Regelkreis festgestellt."
        : "Die Auswirkung auf den Regelkreis ließ sich aus diesem Log nicht beurteilen.";

  // ---- severity ladder: strong words need agreeing signals ----

  let level;

  if (raw <= RAW_MODERATE) {
    level = "observed";
  } else if (managed && controlImpact !== true) {
    // The missing conceptual state: physically present,
    // successfully managed.
    level = "observed";
  } else if (raw > RAW_STRONG) {
    // Strong raw amplitude alone earns "suspected". "Strong
    // evidence" needs the filters demonstrably losing AND the
    // control loop measurably suffering — independent signals
    // agreeing, not one number crossing a line.
    level =
      filteringKnown &&
      reductionPercent < 70 &&
      trackingConcern === true
        ? "strong"
        : "suspected";
  } else {
    level = "review";
  }

  const recommendation =
    level === "observed" && raw > RAW_MODERATE
      ? "Vibration ist vorhanden, wird aber erfolgreich beherrscht. Keine Änderung empfohlen. Nur mechanisch prüfen, wenn diese Spitze über die Flüge wächst oder beginnt, den gefilterten Gyro zu erreichen."
      : level === "observed"
        ? "Kein Handlungsbedarf: eine saubere, gut gewuchtete Maschine."
        : level === "review"
          ? "Bei Gelegenheit an der Werkbank prüfen; nach jeder mechanischen Änderung erneut loggen und vergleichen."
          : level === "suspected"
            ? "Mechanische Prüfung empfohlen: Wucht, Spurlauf, Dämpfung und Lager im genannten Frequenzgebiet, dann erneut loggen. Filter unterdrücken, was der Gyro sieht; sie entfernen nicht die physische Vibration."
            : "Mehrere Signale stimmen überein: starke Rohvibration, Filter beherrschen sie nicht, und Auswirkung auf den Regelkreis. Mechanik im genannten Frequenzgebiet vor weiteren Flügen prüfen, dann erneut loggen.";

  return {
    level,
    managed,
    controlImpact,
    detected,
    filtering,
    impact,
    recommendation
  };
}
