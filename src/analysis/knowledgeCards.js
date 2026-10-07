// ======================================================
// KNOWLEDGE CARDS — what each tunable setting really does
// ======================================================
//
// One card per setting the engine may ever recommend:
// plain-words meaning, direction semantics, the firmware's
// real range, the scaling traps, the fleet's value band,
// and the numeric step a "small step" means for THIS
// setting. Cards are what turn "review the damping" into
// "raise roll damping 10 → 15".
//
// VERSION-PINNED: everything here was verified against the
// firmware source of the 4.6 line. On a log from any other
// firmware family the engine downgrades to directional
// advice — a card must never claim numeric knowledge it
// has not verified.
//
// Fleet bands come from contributed CLI dumps (percentiles
// of the values real machines fly). They are a plausibility
// guardrail, NOT proof of a good tune: a numeric step never
// crosses the band edge in its direction of travel.
//
// ======================================================

export const CARDS_FIRMWARE_PIN = "4.6";

export function cardsApplyTo(firmwareRevision) {
  return typeof firmwareRevision === "string" &&
    firmwareRevision.includes(CARDS_FIRMWARE_PIN);
}

const GAIN_RANGE = { min: 0, max: 1000 };

export const KNOWLEDGE_CARDS = {
  roll_d_gain: {
    axis: "Roll",
    meaning: "Roll-Dämpfung — wie fest die Rollachse beim Bewegen gebremst wird.",
    up: "beruhigt Überschwingen und Pendeln nach Roll-Eingaben",
    down: "befreit eine träge, übergebremste Roll-Antwort",
    range: GAIN_RANGE,
    fleetBand: { p10: 0, p90: 20 },
    step: 5,
    note: "Die Roll-Dämpfungswerte sind intern viel gröber skaliert als bei Nick — dieselbe Zahl ist auf Roll eine viel stärkere Bremse."
  },
  pitch_d_gain: {
    axis: "Pitch",
    meaning: "Nick-Dämpfung — wie fest die Nickachse beim Bewegen gebremst wird.",
    up: "beruhigt Überschwingen und Pendeln nach Nick-Eingaben",
    down: "befreit eine träge, übergebremste Nick-Antwort",
    range: GAIN_RANGE,
    fleetBand: { p10: 12, p90: 65 },
    step: 8
  },
  yaw_d_gain: {
    axis: "Yaw",
    meaning: "Heck-Dämpfung — wie fest die Gierbewegung gebremst wird.",
    up: "beruhigt Heckwackeln und Überschwingen bei Stopps",
    down: "befreit ein schwammiges, übergebremstes Heck",
    range: GAIN_RANGE,
    fleetBand: { p10: 10, p90: 45 },
    step: 8
  },
  roll_f_gain: {
    axis: "Roll",
    meaning: "Roll-Feedforward — wie viel Stick direkt, vor dem Rückkopplungskreis, an die Taumelscheibe geht.",
    up: "schärft die erste Antwort auf Roll-Eingaben und entlastet den I-Anteil",
    down: "mildert eine übereifrige erste Antwort",
    range: GAIN_RANGE,
    fleetBand: { p10: 95, p90: 125 },
    step: 5
  },
  pitch_f_gain: {
    axis: "Pitch",
    meaning: "Nick-Feedforward — wie viel Stick direkt, vor dem Rückkopplungskreis, an die Taumelscheibe geht.",
    up: "schärft die erste Antwort auf Nick-Eingaben und entlastet den I-Anteil",
    down: "mildert eine übereifrige erste Antwort",
    range: GAIN_RANGE,
    fleetBand: { p10: 95, p90: 130 },
    step: 5
  },
  yaw_f_gain: {
    axis: "Yaw",
    meaning: "Gier-Feedforward — Stick direkt zum Heck, vor dem Rückkopplungskreis.",
    up: "schärft Gier-Starts und entlastet den I-Anteil",
    down: "mildert übereifrige Gier-Starts",
    range: GAIN_RANGE,
    fleetBand: { p10: 0, p90: 15 },
    step: 5
  },
  roll_p_gain: {
    axis: "Roll",
    meaning: "Roll-Proportionalanteil — wie hart der Regelkreis gegen den Roll-Fehler drückt.",
    up: "strafft die Nachführung gegen Störungen",
    down: "beruhigt ein nervöses, schwingungsanfälliges Roll",
    range: GAIN_RANGE,
    fleetBand: { p10: 48, p90: 70 },
    step: 5
  },
  pitch_p_gain: {
    axis: "Pitch",
    meaning: "Nick-Proportionalanteil — wie hart der Regelkreis gegen den Nick-Fehler drückt.",
    up: "strafft die Nachführung gegen Störungen",
    down: "beruhigt ein nervöses, schwingungsanfälliges Nicken",
    range: GAIN_RANGE,
    fleetBand: { p10: 50, p90: 120 },
    step: 10
  },
  yaw_p_gain: {
    axis: "Yaw",
    meaning: "Gier-Proportionalanteil — wie hart der Regelkreis gegen den Heckfehler drückt. Multipliziert sich mit den Stop-Gains.",
    up: "festigt Heckhalt und Stopps",
    down: "beruhigt Heckschwingen",
    range: GAIN_RANGE,
    fleetBand: { p10: 65, p90: 115 },
    step: 8
  },
  yaw_cw_stop_gain: {
    axis: "Yaw",
    meaning: "Rechtsdreh-Stop-Gain — zusätzliche Autorität beim Abfangen einer Drehung im Uhrzeigersinn.",
    up: "knackigere Stopps im Uhrzeigersinn",
    down: "weichere Stopps im Uhrzeigersinn (weniger Nachfedern)",
    range: { min: 25, max: 250 },
    fleetBand: { p10: 110, p90: 130 },
    step: 5,
    note: "Richtungsspezifisch: Ein einseitiges Stopp-Problem weist hierauf, ein symmetrisches auf Yaw-P."
  },
  yaw_ccw_stop_gain: {
    axis: "Yaw",
    meaning: "Linksdreh-Stop-Gain — zusätzliche Autorität beim Abfangen einer Drehung gegen den Uhrzeigersinn.",
    up: "knackigere Stopps gegen den Uhrzeigersinn",
    down: "weichere Stopps gegen den Uhrzeigersinn (weniger Nachfedern)",
    range: { min: 25, max: 250 },
    fleetBand: { p10: 80, p90: 85 },
    step: 5,
    note: "Richtungsspezifisch: Ein einseitiges Stopp-Problem weist hierauf, ein symmetrisches auf Yaw-P."
  },
  yaw_collective_ff_gain: {
    axis: "Yaw",
    meaning: "Kollektiv-zu-Gier-Precomp — kontert den Heck-Kick, den Kollektiv-Pitch erzeugt.",
    up: "stärkeres Gegensteuern gegen den Kick bei Kollektiv-Bewegungen",
    down: "schwächeres Gegensteuern (nutzen, wenn das Heck bei Kollektiv überkorrigiert)",
    range: { min: 0, max: 250 },
    fleetBand: { p10: 45, p90: 60 },
    step: 5
  },
  gov_gain: {
    meaning: "Governor-Master-Gain — skaliert die gesamte Headspeed-Regelung auf einmal.",
    up: "insgesamt festeres Halten der Headspeed",
    down: "beruhigt Governor-Pendeln insgesamt",
    range: { min: 0, max: 250 },
    fleetBand: { p10: 40, p90: 50 },
    step: 5,
    note: "Skaliert alle Governor-Anteile zusammen — ändere ihn nie gleichzeitig mit einem einzelnen Governor-Gain."
  },
  gov_p_gain: {
    meaning: "Governor-Proportionalanteil — sofortige Reaktion auf Headspeed-Fehler.",
    up: "schnelleres Abfangen von Einbrüchen",
    down: "beruhigt schnelles Governor-Schwingen",
    range: { min: 0, max: 250 },
    fleetBand: { p10: 25, p90: 40 },
    step: 5
  },
  gov_i_gain: {
    meaning: "Governor-Integralanteil — wie schnell anhaltender Droop abgearbeitet wird.",
    up: "schnellere Erholung von anhaltendem Droop",
    down: "beruhigt langsames Headspeed-Wabern",
    range: { min: 0, max: 250 },
    fleetBand: { p10: 50, p90: 60 },
    step: 5
  },
  // Measured 2026-08-25 on the contributed fleet's governed crafts:
  // collective precomp clusters tightly (p10 10 / median 10 / p90 12,
  // nobody at zero) — the fleet flies the firmware's neighborhood and
  // rarely touches it. The tight band makes the p90 guardrail bite
  // early by design: precomp is stepped in small moves, verified by
  // the rise-droop read, never chased.
  gov_f_gain: {
    meaning:
      "Governor-Kollektiv-Feedforward — Leistung wird angefordert, wenn die Kollektiv-Last ankommt, bevor Droop entsteht.",
    up: "fordert die Leistung an, bevor die Last landet — verkleinert den Droop beim Anstieg",
    down: "beruhigt Rotor-Überdrehzahl nach Kollektiv-Abfällen",
    range: { min: 0, max: 250 },
    fleetBand: { p10: 10, p90: 12 },
    step: 5
  }
};

export function getCard(setting) {
  return KNOWLEDGE_CARDS[setting] ?? null;
}

/**
 * The numeric step a recommendation means, from the craft's actual
 * current value. Returns { from, to } or null when no honest number
 * exists (no card, no finite current value, or the current value
 * already sits at/beyond the fleet band edge in the direction of
 * travel — then the recommendation stays directional and says why).
 */
export function numericStep(setting, currentValue, direction) {
  const card = getCard(setting);
  const from = Number(currentValue);

  if (!card || !Number.isFinite(from)) {
    return null;
  }

  const sign = direction === "down" ? -1 : 1;
  let to = from + sign * card.step;

  // Firmware range is a hard wall.
  to = Math.min(card.range.max, Math.max(card.range.min, to));

  // Fleet band edge is the guardrail in the direction of travel:
  // never step past it, and never issue a number when the craft
  // already sits at or beyond it.
  const edge = sign > 0 ? card.fleetBand.p90 : card.fleetBand.p10;
  const beyond = sign > 0 ? from >= edge : from <= edge;

  if (beyond) {
    return null;
  }

  to = sign > 0 ? Math.min(to, edge) : Math.max(to, edge);

  return to === from ? null : { from, to };
}
