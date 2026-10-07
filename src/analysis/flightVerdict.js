// ======================================================
// BLACKBOX LAB — FLIGHT VERDICT
// ======================================================
//
// The plain-language layer: turns numbers into the story
// a pilot needs first. Every verdict card carries:
//
//   status   "good" | "watch" | "attention"
//   headline one short sentence, no jargon
//   detail   one more sentence of why
//   screen   which Lab shows the evidence
//
// Simple first. Deeper when you want it.
//
// ======================================================

import { VIBRATION_FLOOR_HZ } from "./dsp/fft.js";
import { assessVibrationConclusion } from "./vibrationSeverity.js";
import { magnitudeNear } from "./filterAdvisor.js";

function averageOf(values) {
  if (!values || values.length === 0) {
    return null;
  }

  let sum = 0;

  for (const value of values) {
    sum += value;
  }

  return sum / values.length;
}

// ------------------------------------------------------
// Vibration verdict — from the noise spectrum peaks
// ------------------------------------------------------
function vibrationVerdict(spectra, headspeedRpm, filterAdvice, pidAnalysis) {
  if (!spectra || spectra.length === 0) {
    return null;
  }

  // Strongest peak above the vibration floor across all gyro axes.
  let peakHz = 0;
  let peakMagnitude = 0;

  for (const { spectrum } of spectra) {
    for (let i = 0; i < spectrum.frequencies.length; i += 1) {
      if (
        spectrum.frequencies[i] >= VIBRATION_FLOOR_HZ &&
        spectrum.magnitudes[i] > peakMagnitude
      ) {
        peakMagnitude = spectrum.magnitudes[i];
        peakHz = spectrum.frequencies[i];
      }
    }
  }

  if (peakMagnitude === 0) {
    return null;
  }

  // Name the peak if it matches a rotor frequency — and carry the
  // matching wrench-in-hand action separately: the Verdict explains
  // with `source`, Try This First commands with `sourceAction`, and
  // neither repeats the other.
  let source = "eine nicht identifizierte Quelle";
  let sourceAction =
    "Prüfe bei der nächsten Werkbank-Session die rotierenden Teile auf Wuchtung und Spiel.";

  if (headspeedRpm && headspeedRpm > 300) {
    const oneRev = headspeedRpm / 60;
    const ratio = peakHz / oneRev;

    if (Math.abs(ratio - 1) < 0.15) {
      source = "der HAUPTROTOR, der einmal pro Umdrehung vibriert, meist Blattwucht oder Kopfdämpfung";
      sourceAction = "Wuchte und spure die Hauptblätter und prüfe die Kopfdämpfung.";
    } else if (Math.abs(ratio - 2) < 0.2) {
      source = "zweimal pro Umdrehung des Hauptrotors, oft Blattspurlauf oder Kopfspiel";
      sourceAction = "Prüfe den Blattspurlauf und den Kopf auf Spiel.";
    } else if (ratio > 3.5 && ratio < 6.5) {
      source = "der HECKROTOR-Bereich: Heckblätter, Riemen/Welle und Lager prüfen";
      sourceAction = "Prüfe die Heckblätter, die Spannung von Riemen oder Welle und die Heck-Lager.";
    } else if (ratio > 6.5) {
      source = "eine hochfrequente Quelle: Motor-, Ritzel- oder Lagergebiet";
      sourceAction = "Prüfe die Motorbefestigung, den Ritzeleingriff und die Lager.";
    }
  }

  const magnitudeLabel = peakMagnitude.toFixed(1);
  const hzLabel = peakHz.toFixed(0);

  // Filtering evidence for THIS peak, when the advisor measured it:
  // raw amplitude alone never decides the verdict again.
  const advisorRow =
    filterAdvice?.rows?.find(
      (row) => Math.abs(row.hz - peakHz) <= 3
    ) ?? null;

  // The verdict's peak and the advisor's rows come from separate
  // peak-finders, so a peak the advisor kept no row for is normal
  // — but when a filtered spectrum EXISTS, the card must not claim
  // the log has no filtered trace. Read the residual at this
  // peak's own frequency directly instead.
  let reductionPercent = advisorRow?.reductionPercent ?? null;
  let residualMagnitude = advisorRow?.filteredMagnitude ?? null;

  if (
    !advisorRow &&
    filterAdvice?.filteredSpectrum &&
    peakMagnitude > 0
  ) {
    const residual = magnitudeNear(
      filterAdvice.filteredSpectrum,
      peakHz
    );

    if (Number.isFinite(residual)) {
      residualMagnitude = residual;
      reductionPercent = Math.max(
        0,
        ((peakMagnitude - residual) / peakMagnitude) * 100
      );
    }
  }

  const conclusion = assessVibrationConclusion({
    rawMagnitude: peakMagnitude,
    hz: peakHz,
    source,
    reductionPercent,
    residualMagnitude,
    trackingConcern: Number.isFinite(pidAnalysis?.score)
      ? pidAnalysis.score < 70
      : null
  });

  // Detection stays sensitive; the card's status follows the
  // evidence-gated conclusion. A managed strong peak stays visible
  // as "watch" — filters do not remove vibration from bearings.
  const status =
    conclusion.level === "strong" || conclusion.level === "suspected"
      ? "attention"
      : conclusion.level === "review" ||
          (conclusion.managed && peakMagnitude > 8)
        ? "watch"
        : "good";

  const headline =
    conclusion.level === "observed" && peakMagnitude > 3
      ? `Vibration bei ${hzLabel} Hz: durch Filterung beherrscht`
      : peakMagnitude > 8
        ? `Starke Vibration bei ${hzLabel} Hz`
        : peakMagnitude > 3
          ? `Vibration bei ${hzLabel} Hz`
          : "Die Vibrationswerte sehen gesund aus";

  const detail =
    peakMagnitude > 3
      ? `${conclusion.detected} ${conclusion.filtering} ${conclusion.impact}`
      : `Größte Spitze nur ${magnitudeLabel} bei ${hzLabel} Hz: eine saubere, gut gewuchtete Maschine.`;

  return {
    key: "vibration",
    title: "Vibration",
    status,
    headline,
    detail,
    action: conclusion.recommendation,
    // Structured peak facts, so downstream text (the Try First
    // panel) can speak about the same peak without parsing prose.
    peak: {
      hz: Math.round(peakHz),
      sourceAction,
      magnitude: Math.round(peakMagnitude * 10) / 10,
      source,
      reductionPercent: Number.isFinite(reductionPercent)
        ? Math.round(reductionPercent)
        : null,
      managed: conclusion.managed === true,
      identified: source !== "eine nicht identifizierte Quelle"
    },
    screen: "filter",
    evidence: "Rauschspektrum-Diagramm, Filter-Labor"
  };
}

// ------------------------------------------------------
// Rotor speed verdict — how well headspeed held
// ------------------------------------------------------
function rotorSpeedVerdict(headspeed, governorTarget) {
  if (!headspeed || headspeed.length < 100) {
    return null;
  }

  // Judge only the governed part of the flight (target
  // reached), so spool-up doesn't count against it.
  const pairs = [];

  for (let i = 0; i < headspeed.length; i += 1) {
    const target = governorTarget ? governorTarget[i] : null;

    if (target && target > 300 && headspeed[i] > target * 0.85) {
      pairs.push([headspeed[i], target]);
    }
  }

  if (pairs.length < 100) {
    return null;
  }

  let maximumDroop = 0;
  let errorSum = 0;

  for (const [actual, target] of pairs) {
    const droop = target - actual;
    errorSum += Math.abs(droop);

    if (droop > maximumDroop) {
      maximumDroop = droop;
    }
  }

  const averageTarget = averageOf(pairs.map((pair) => pair[1]));
  const droopPercent = (maximumDroop / averageTarget) * 100;

  if (droopPercent > 3) {
    return {
      key: "rotor",
      title: "Rotordrehzahl",
      status: "attention",
      headline: `Die Headspeed sackt unter Last um bis zu ${Math.round(maximumDroop)} U/min ein`,
      detail: `Das sind ${droopPercent.toFixed(1)} % unter dem Ziel. Der Governor braucht mehr Gain oder das Antriebssystem mehr Reserve.`,
      action: "Erhöhe im Rotorflight Configurator den Governor-Gain in kleinen Schritten oder prüfe im ESC-Labor, ob Leistungsreserve fehlt.",
      screen: "governor",
      evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
    };
  }

  if (droopPercent > 1.2) {
    return {
      key: "rotor",
      title: "Rotordrehzahl",
      status: "watch",
      headline: `Die Headspeed fällt beim Kollektiv um ${Math.round(maximumDroop)} U/min`,
      detail: `${droopPercent.toFixed(1)} % Droop sind flugtauglich; etwas mehr Governor-Gain könnte ihn straffen.`,
      action: "Optional: In der nächsten Session den Governor-Gain leicht erhöhen.",
      screen: "governor",
      evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
    };
  }

  return {
    key: "rotor",
    title: "Rotordrehzahl",
    status: "good",
    headline: "Felsenfeste Headspeed",
    detail: `Schlimmster Droop nur ${Math.round(maximumDroop)} U/min (${droopPercent.toFixed(1)} %): Der Governor macht seine Arbeit.`,
    action: "Nichts zu tun. So sieht gut aus.",
    screen: "governor",
    evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
  };
}

// ------------------------------------------------------
// Tuning verdict — from the PID Lab score
// ------------------------------------------------------
function tuningVerdict(pidAnalysis, { vibrationConcern = false } = {}) {
  const score = pidAnalysis?.score;
  const overallStatus =
    pidAnalysis?.overallStatus ?? null;
  const confidenceLevel = pidAnalysis?.confidence?.level ?? null;
  const thinEvidence =
    confidenceLevel === "Low" || confidenceLevel === "Insufficient";

  // A score earned in a gentle hover and one earned in hard
  // maneuvers are different measurements wearing the same number
  // — the card says which one this was, so nobody compares them.
  const hoverDemand =
    pidAnalysis?.technicalSummary?.demand?.hoverLevel === true;

  const demandSuffix = hoverDemand ? " bei sanfter Anforderung" : "";

  if (
    overallStatus === "Insufficient Data" ||
    !Number.isFinite(score)
  ) {
    return {
      key: "tuning",
      title: "Tuning",
      status: "watch",
      headline: "PID-Nachführung konnte nicht gemessen werden",
      detail:
        "Setpoint-Daten waren vorhanden, aber es standen keine gültigen Achsen-Antwort- oder Nachführungs-Fenster zur Verfügung. Dieser Flug kann keine PID-Tuning-Punktzahl tragen.",
      action:
        "Ändere aufgrund dieses Ergebnisses keine PID-Werte. Öffne das PID-Labor, um die fehlenden Belege zu prüfen.",
      screen: "pid",
      evidence: "PID-Labor-Befunde"
    };
  }

  // Bands follow the fleet, like every other status in the app:
  // the corpus median tracking score sits near 87, so "crisp"
  // is reserved for the better half of real machines. 65 is the
  // worse-than-most line (score-space p90 territory), not a
  // universal grade scale.
  if (score < 65) {
    return {
      key: "tuning",
      title: "Tuning",
      status: "attention",
      headline: `Nachführ-Punktzahl ${score}/100: Luft nach oben`,
      detail:
        "Der Heli hinkt dem hinterher oder schießt über das hinaus, was die Sticks verlangen. Das PID-Labor listet die Ereignisse hinter dieser Zahl.",
      action:
        "Öffne das PID-Labor und lass dessen Empfehlungen das Änderungspaket dieses Fluges füllen.",
      screen: "pid",
      evidence: "PID-Labor-Befunde"
    };
  }

  // The score measures tracking and only tracking — it CAN be high
  // while the airframe shakes, because the filtered gyro still
  // follows the stick. But a tune read through an open vibration
  // finding is not a tune to be enjoyed: the recommendation engine
  // already holds every tuning change on it (filters before PIDs),
  // and the card must say the same — the number stands, the
  // verdict waits for the flight after the fix.
  if (vibrationConcern) {
    return {
      key: "tuning",
      title: "Tuning",
      status: "watch",
      headline: `Nachführ-Punktzahl ${score}/100, gelesen durch einen Vibrationsbefund${demandSuffix}`,
      detail:
        "Die Antwort folgt den Sticks, aber in diesem Flug ist eine starke Vibration offen — die Tuning-Instrumente werden durch sie hindurch gelesen, und es wird keine Tuning-Änderung verdient, bis die mechanische Ursache behoben ist.",
      action:
        "Behebe zuerst die Vibration (siehe Vibrations-Karte), fliege erneut und lies diese Punktzahl in diesem Flug frisch.",
      screen: "pid",
      evidence: "PID-Labor-Befunde"
    };
  }

  // The card and the PID Lab must tell the same story: when the
  // Lab's own status says "Review", the Home card cannot say
  // "crisp" — whatever the score. One source of truth.
  if (overallStatus === "Review") {
    return {
      key: "tuning",
      title: "Tuning",
      status: "watch",
      headline: `Nachführ-Punktzahl ${score}/100: Punkte zum Prüfen${demandSuffix}`,
      detail:
        "Die Antwort folgt den Sticks, aber das PID-Labor markiert Befunde, die man lesen sollte, bevor man das Tuning für fertig erklärt.",
      action:
        "Öffne das PID-Labor und lies seine Prüfpunkte: Sie sagen genau, wo du hinschauen sollst.",
      screen: "pid",
      evidence: "PID-Labor-Befunde"
    };
  }

  // "Crisp" is a claim; thin evidence cannot carry it. Few clean
  // commands make a high score a hover's score, not a tune's.
  if (thinEvidence) {
    return {
      key: "tuning",
      title: "Tuning",
      status: "watch",
      headline: `Nachführ-Punktzahl ${score}/100 bei dünner Beleglage${demandSuffix}`,
      detail:
        "Die Maschine folgte den wenigen sauberen Kommandos dieses Fluges, aber es waren zu wenige, um das Tuning knackig zu nennen — die Punktzahl ist ehrlich, die Sicherheit fehlt noch.",
      action:
        "Fliege 4–6 bewusste Stopps und Umkehrungen je Achse bei einer Headspeed; dann hat das PID-Labor die Belege, um das Tuning zu bewerten.",
      screen: "pid",
      evidence: "PID-Labor-Befunde"
    };
  }

  if (score < 85) {
    return {
      key: "tuning",
      title: "Tuning",
      status: "watch",
      headline: `Nachführ-Punktzahl ${score}/100: ordentlich, nicht knackig${demandSuffix}`,
      detail:
        "Die Antwort folgt den Sticks überwiegend; das PID-Labor zeigt, wo sie sich lockert.",
      action:
        "Wenn du es schärfer willst, zeigt das PID-Labor, wo du hinschauen sollst.",
      screen: "pid",
      evidence: "PID-Labor-Befunde"
    };
  }

  return {
    key: "tuning",
    title: "Tuning",
    status: "good",
    headline: `Nachführ-Punktzahl ${score}/100: knackige Antwort${demandSuffix}`,
    detail: hoverDemand
      ? "Die Maschine folgt den Sticks treu, bei der sanften Anforderung, die dieser Flug stellte. Eine Punktzahl aus einem härteren Flug ist eine andere Messung."
      : "Die Maschine folgt den Sticks treu.",
    action: "Nichts zu tun. Viel Spaß damit.",
    screen: "pid",
    evidence: "PID-Labor-Befunde"
  };
}
  

  

  
  


// ------------------------------------------------------
// Battery verdict — voltage sag over the flight
// ------------------------------------------------------
function batteryVerdict(vbat) {
  if (!vbat || vbat.length < 100) {
    return null;
  }

  // vbatLatest is typically volts × 100.
  const start = averageOf(vbat.slice(0, 50)) / 100;
  const end = averageOf(vbat.slice(-50)) / 100;

  if (!start || start < 5) {
    return null;
  }

  const sagPercent = ((start - end) / start) * 100;

  if (sagPercent > 12) {
    return {
      key: "battery",
      title: "Akku",
      status: "attention",
      headline: `Die Spannung fiel im Flug um ${sagPercent.toFixed(0)} %`,
      detail: `${start.toFixed(1)} V → ${end.toFixed(1)} V: ein alternder Akku oder ein lang/hart geflogener Flug.`,
      action: "Lande früher oder setze diesen Akku für sanftere Einsätze ein. Das Akku-Labor hat die Details.",
      screen: "viewer",
      evidence: "Diagramm Motor & Leistung, Log-Ansicht"
    };
  }

  return {
    key: "battery",
    title: "Akku",
    status: "good",
    headline: "Der Akku hielt gut durch",
    detail: `${start.toFixed(1)} V → ${end.toFixed(1)} V über den Flug.`,
    action: "Nichts zu tun.",
    screen: "viewer",
    evidence: "Diagramm Motor & Leistung, Log-Ansicht"
  };
}
function rotorSpeedVerdictFromLab(governorLab) {
  if (!governorLab) {
    return null;
  }

  // Models that state no governor target still get a rotor
  // story: hold judged against the rotor's own trend. Without
  // a target there is no contract to break, so this card never
  // goes past "watch".
  if (
    governorLab.mode === "headspeed-hold" &&
    governorLab.status !== "insufficient" &&
    Number.isFinite(governorLab.droopRpm)
  ) {
    return {
      key: "rotor",
      title: "Rotordrehzahl",
      status: governorLab.status,
      // The stability RESULT may be favorable, but without a target
      // there is no governed contract to score — the label says
      // partial, never a scored-quality word.
      statusLabel: "Teilweise: nur Stabilität",
      headline:
        governorLab.status === "good"
          ? `Die Headspeed hielt sich stabil bei etwa ${governorLab.averageHeadspeed} U/min`
          : `Die Headspeed schwankte kurzfristig um ${Math.round( governorLab.droopRpm )} U/min`,
      detail: `Es ist kein Governor-Ziel geloggt, deshalb wird das Halten am eigenen Trend des Rotors beurteilt: größte kurzfristige Schwankung ${Math.round( governorLab.droopRpm )} U/min (${governorLab.droopPercent.toFixed(1)} %).`,
      action:
        governorLab.status === "good"
          ? "Aufgrund dieses Ergebnisses ist nichts zu ändern."
          : "Einen Blick auf diesen Moment im Governor-Labor-Diagramm wert. Bewusste Headspeed-Änderungen werden dagegen nicht gezählt.",
      screen: "governor",
      evidence: "Diagramm Headspeed im Zeitverlauf, Governor-Labor"
    };
  }

  if (
    governorLab.status === "insufficient" ||
    !Number.isFinite(governorLab.droopRpm)
  ) {
    return {
      key: "rotor",
      title: "Rotordrehzahl",
      // Not logged is not unhealthy: a model without an RPM sensor
      // gets the greyed card, not a yellow one.
      status:
        governorLab.hasRotorSpeedData === false &&
        governorLab.movedDuringRecording !== false
          ? "unavailable"
          : "watch",
      statusLabel:
        governorLab.hasRotorSpeedData === false &&
        governorLab.movedDuringRecording !== false
          ? "nicht geloggt"
          : null,
      headline:
        governorLab.movedDuringRecording === false
          ? "In dieser Aufzeichnung wurde kein Flug gefunden"
          : governorLab.hasRotorSpeedData === false
            ? "Keine Rotordrehzahl-Daten in diesem Log"
            : "Das Governor-Halten konnte nicht gemessen werden",
      detail:
        governorLab.movedDuringRecording === false
          ? "Die Sticks und Servos bewegen sich in diesem Log, aber das Fluggerät selbst nie, und es wurde keine Rotordrehzahl aufgezeichnet. Das ist die Signatur eines Werkbank- oder Bodenlaufs und nicht eines Fluges."
          : governorLab.hasRotorSpeedData === false
            ? "Dieses Log enthält keine Headspeed, was für ein Modell ohne RPM-Sensor normal ist. Das Governor-Halten wird an der Rotordrehzahl gemessen und lässt sich aus diesem Flug daher nicht bewerten."
            : "Kein stabiler Governor-Flugabschnitt war lang genug für ein verlässliches Governor-Ergebnis.",
      action:
        governorLab.movedDuringRecording === false
          ? "Öffne ein im Flug aufgezeichnetes Log. Falls das ein Flug war, prüfe, ob Gyro und RPM-Sensor geloggt werden."
          : governorLab.hasRotorSpeedData === false
            ? "Am Log ist nichts zu beheben. Baue einen RPM-Sensor ein und aktiviere ihn, wenn du eine Governor-Bewertung willst."
            : "Ändere aufgrund dieses Fluges keine Governor-Einstellungen.",
      screen: "governor",
      evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
    };
  }

  const droopRpm = governorLab.droopRpm;
  const droopPercent = governorLab.droopPercent;

  // A deep sustained dip under load anywhere in the flight is
  // the headline, and the motor output at that moment decides
  // what the card recommends: at the ceiling, the fix is power,
  // not governor gain.
  const flightDipSevere =
    Number.isFinite(governorLab.flightDroopPercent) &&
    governorLab.flightDroopPercent > 8;

  if (flightDipSevere) {
    const outputAtCeiling =
      Number.isFinite(governorLab.flightDroopOutputPercent) &&
      governorLab.flightDroopOutputPercent >= 95;

    return {
      key: "rotor",
      title: "Rotordrehzahl",
      status: "attention",
      headline: `Der Rotor fiel unter Last um ${Math.round( governorLab.flightDroopRpm )} U/min ein`,
      detail: `Ein anhaltender Einbruch von ${governorLab.flightDroopPercent.toFixed( 1 )} % unter das Ziel${ Number.isFinite(governorLab.flightDroopOutputPercent) ? ` bei einem Motorausgang von ${Math.round( governorLab.flightDroopOutputPercent )} %` : "" }.`,
      action: outputAtCeiling
        ? "Der Ausgang stand bereits an seiner Obergrenze, mehr Governor-Gain kann also nicht helfen. Senke die Headspeed, nimm etwas Pitch heraus oder passe Übersetzung/Kv an deine Ziel-Headspeed an. Das ESC-Labor zeigt den Moment."
        : "Sieh dir das Ereignis mit dem schlimmsten Droop im Governor-Labor an, bevor du Gain oder Antriebs-Einstellungen änderst.",
      screen: "governor",
      evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
    };
  }

  if (governorLab.status === "attention") {
    return {
      key: "rotor",
      title: "Rotordrehzahl",
      status: "attention",
      headline: `Anhaltender Einbruch von ${Math.round( droopRpm )} U/min im stabilen Flug`,
      detail: `${droopPercent.toFixed( 1 )} % unter dem Ziel, eine Viertelsekunde oder länger gehalten.`,
      action:
        "Sieh dir das passende Ereignis im Governor-Labor an, bevor du Gain oder Antriebs-Einstellungen änderst.",
      screen: "governor",
      evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
    };
  }

  if (governorLab.status === "watch") {
    return {
      key: "rotor",
      title: "Rotordrehzahl",
      status: "watch",
      headline: `Anhaltender Einbruch von ${Math.round( droopRpm )} U/min im stabilen Flug`,
      detail: `${droopPercent.toFixed( 1 )} % unter dem Ziel. Sieh dir das Ereignis an, bevor du eine Governor-Änderung machst.`,
      action:
        "Keine automatische Änderung empfohlen. Bestätige, dass der Einbruch bei einer echten Last in der Luft auftrat.",
      screen: "governor",
      evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
    };
  }

  return {
    key: "rotor",
    title: "Rotordrehzahl",
    status: "good",
    headline: "Felsenfeste Headspeed",
    detail: `Größter anhaltender Einbruch war ${Math.round( droopRpm )} U/min (${droopPercent.toFixed(1)} %).`,
    action: "Aufgrund dieses Ergebnisses ist nichts zu ändern.",
    screen: "governor",
    evidence: "Diagramm Headspeed gegen Ziel, Governor-Labor"
  };
}

function batteryVerdictFromLab(batteryLab) {
  if (!batteryLab) {
    return null;
  }

  if (
    batteryLab.status === "insufficient" ||
    !Number.isFinite(batteryLab.minimumVoltsPerCell)
  ) {
    return {
      key: "battery",
      title: "Akku",
      status:
        batteryLab.hasRotorSpeedData === false ? "unavailable" : "watch",
      statusLabel:
        batteryLab.hasRotorSpeedData === false ? "nicht messbar" : null,
      headline:
        batteryLab.hasRotorSpeedData === false
          ? "Die Akku-Bewertung braucht Rotordrehzahl-Daten"
          : "Der Akku-Zustand konnte nicht beurteilt werden",
      detail:
        batteryLab.hasRotorSpeedData === false
          ? "Der Zustand des Akkus wird über einen Abschnitt mit gleichmäßiger Last beurteilt, den diese App an der Rotordrehzahl erkennt. Dieses Log enthält keine, deshalb lässt sich der Akku aus diesem Flug nicht bewerten."
          : "Kein stabiler Governor-Flugabschnitt war lang genug für ein verlässliches Akku-Ergebnis.",
      action:
        batteryLab.hasRotorSpeedData === false
          ? "Am Log ist nichts zu beheben. Nutze das Diagramm „Spannung über den Flug“, um den Akku direkt anzusehen."
          : "Beurteile den Akku nicht allein anhand dieses Fluges.",
      screen: "battery",
      evidence: "Diagramm Spannung über den Flug, Akku-Labor"
    };
  }

  const minimumPerCell =
    batteryLab.minimumVoltsPerCell;

  if (batteryLab.status === "attention") {
    return {
      key: "battery",
      title: "Akku",
      status: "attention",
      headline: "Niedrige Spannung im stabilen Flug beobachtet",
      detail: `Die niedrigste Spannung im Flug war ${minimumPerCell.toFixed( 2 )} V pro Zelle.`,
      action:
        "Sieh dir das passende Strom- und Gas-Ereignis im Akku-Labor an.",
      screen: "battery",
      evidence: "Diagramm Spannung über den Flug, Akku-Labor"
    };
  }

  if (batteryLab.status === "watch") {
    return {
      key: "battery",
      title: "Akku",
      status: "watch",
      headline: "Die Spannung unter Last ist einen Blick wert",
      detail: `Die niedrigste Spannung im Flug war ${minimumPerCell.toFixed( 2 )} V pro Zelle. Das allein beweist nicht, dass der Akku schwach ist.`,
      action:
        "Vergleiche den Spannungseinbruch im Akku-Labor mit dem Strombedarf.",
      screen: "battery",
      evidence: "Diagramm Spannung über den Flug, Akku-Labor"
    };
  }

  return {
    key: "battery",
    title: "Akku",
    status: "good",
    headline: "Der Akku hielt gut durch",
    detail: `Die niedrigste Spannung im Flug war ${minimumPerCell.toFixed( 2 )} V pro Zelle. Kein klares Anzeichen für einen schwachen oder müden Akku.`,
    action: "Aufgrund dieses Ergebnisses ist nichts zu ändern.",
    screen: "battery",
    evidence: "Diagramm Spannung über den Flug, Akku-Labor"
  };
}
// ------------------------------------------------------
// Power verdict — motor output headroom, from the ESC Lab
// ------------------------------------------------------
function powerVerdictFromLab(escLab) {
  if (!escLab || escLab.status === "insufficient") {
    return null;
  }

  const headline =
    escLab.status === "attention"
      ? "Dem Antriebssystem ging die Reserve aus"
      : escLab.status === "watch"
        ? "Die Leistungsreserve wird dünn"
        : "Reichlich Leistung in Reserve";

  const action =
    escLab.status === "attention"
      ? "Senke die Headspeed, nimm etwas Pitch heraus oder passe Übersetzung/Kv an deine Ziel-Headspeed an. Das ESC-Labor zeigt die genauen Momente."
      : escLab.status === "watch"
        ? "Vorerst in Ordnung. Gut zu merken, bevor du der Maschine mehr abverlangst."
        : "Nichts zu tun.";

  return {
    key: "power",
    title: "Antrieb & ESC",
    status: escLab.status,
    headline,
    detail: escLab.story,
    action,
    screen: "esc",
    evidence: "Diagramm Gas-Ausgang, ESC-Labor"
  };
}

// ------------------------------------------------------
// buildFlightVerdict — the one call the renderer makes
// ------------------------------------------------------
// ------------------------------------------------------
// Signal + receiver-power verdicts — from their labs.
// Cards appear only when the log carried the telemetry: an
// absent column is a quality-chip fact, not a Home warning.
// ------------------------------------------------------
function signalVerdict(signalLab) {
  if (!signalLab) return null;

  const status = signalLab.status;

  return {
    key: "signal",
    title: "Signal",
    status,
    headline:
      status === "attention"
        ? signalLab.counts.failsafe > 0
          ? "Die Steuerverbindung wurde unterbrochen"
          : "Die Verbindung braucht einen Blick"
        : status === "watch"
          ? "Das Signal brach ein: Die Verbindung hielt"
          : "Funkverbindung den ganzen Flug über stabil",
    detail: signalLab.story,
    action:
      status === "good"
        ? "Nichts zu tun."
        : "Öffne das Signal-Labor: Die Ereignisse nennen jeden Moment.",
    screen: "signal",
    evidence: "Signal-Labor-Ereignisse"
  };
}

function becVerdict(becLab) {
  if (!becLab) return null;

  const status = becLab.status;

  return {
    key: "bec",
    title: "BEC-Ausgang",
    status,
    headline:
      status === "attention"
        ? "Der BEC-Ausgang braucht Aufmerksamkeit"
        : status === "watch"
          ? becLab.implausibleBrownout
            ? "Spannungswert einen Check wert"
            : "Die BEC-Spannung brach ein"
          : "BEC-Ausgang felsenfest",
    detail: becLab.story,
    action:
      status === "good"
        ? "Nichts zu tun."
        : "Öffne das BEC-Labor: Jeder Einbruch trägt seinen Servo-Zusammenhang.",
    screen: "bec",
    evidence: "BEC-Labor-Ereignisse"
  };
}

// ------------------------------------------------------
// Capability gaps — what this log could NOT measure, on the
// card that would have measured it.
// ------------------------------------------------------
//
// The quality gate decides what the log supports; these cards
// repeat that decision where the pilot actually looks. A lab
// with no data is not a card that vanishes: it is a greyed card
// saying what was not logged and how to log it. A lab with
// partial data keeps its verdict and carries the gap beside it
// ("current not measured") — a missing sensor is a finding.
// ------------------------------------------------------

// Which quality chip speaks for which card.
const CARD_CAPABILITY = {
  vibration: "Vibration & Filter",
  rotor: "Governor",
  power: "Akku & ESC",
  battery: "Akku & ESC",
  signal: "Signal & Verbindung",
  bec: "BEC-Ausgang"
};

const UNAVAILABLE_CARDS = {
  vibration: {
    title: "Vibration",
    headline: "Keine Rauschmessung aus diesem Flug",
    screen: "filter",
    evidence: "Filter-Labor",
    fallbackNote:
      "Der Flug blieb nie lange genug gleichmäßig für ein Spektrum, oder das Log enthält keine Gyro-Daten."
  },
  rotor: {
    title: "Rotordrehzahl",
    headline: "Headspeed nicht geloggt",
    screen: "governor",
    evidence: "Governor-Labor"
  },
  power: {
    title: "Antrieb & ESC",
    headline: "Motorausgang nicht messbar",
    screen: "esc",
    evidence: "ESC-Labor",
    fallbackNote:
      "Die Ausgangsreserve braucht Motor- oder ESC-Gas-Ausgang und Rotordrehzahl im Log."
  },
  battery: {
    title: "Akku",
    headline: "Spannung nicht geloggt",
    screen: "battery",
    evidence: "Akku-Labor"
  },
  signal: {
    title: "Signal",
    headline: "Link-Telemetrie nicht geloggt",
    screen: "signal",
    evidence: "Signal-Labor"
  },
  bec: {
    title: "BEC-Ausgang",
    headline: "BEC-Spannung nicht geloggt",
    screen: "bec",
    evidence: "BEC-Labor"
  }
};

// What to DO about a gap — the sensor to check or the telemetry
// to enable. Stated once here; the card, the lab page's first
// step and Home's "not measured" list all read it.
export function gapAdvice(key, capability) {
  const level = capability?.level ?? "missing";
  switch (key) {
    case "battery":
    case "power":
      return level === "missing"
        ? "Keine Spannungs-Telemetrie geloggt. Aktiviere Akku- oder ESC-Spannungs-Telemetrie, damit sich Akku und Antriebssystem beurteilen lassen."
        : "Der Strom wurde nicht gemessen: Der Kanal fehlt oder las den ganzen Flug über null. Prüfe Verkabelung und Skalierung des Stromsensors oder baue einen ein — Verbrauch, Innenwiderstand und Leistungszahlen brauchen ihn.";
    case "rotor":
      return level === "missing"
        ? "Keine Headspeed geloggt. Aktiviere die RPM-Telemetrie, um Governor- und Headspeed-Analyse freizuschalten."
        : "Kein Governor-Ziel geloggt: Die Stabilität wird am eigenen Trend des Rotors beurteilt. Droop gegen das Ziel braucht das Ziel im Log.";
    case "signal":
      return level === "missing"
        ? "Keine Link-Telemetrie geloggt. Aktiviere die RSSI-Telemetrie am Empfänger; dann wird die Verbindung für dich überwacht."
        : "Nur Empfänger-Flags: Aktiviere die Signalstärke-Telemetrie (RSSI) für das volle Bild der Verbindung.";
    case "bec":
      return "Keine BEC-Spannung geloggt. Aktiviere die BEC-Spannungs-Telemetrie, um die Versorgung von Empfänger und Servos zu beobachten.";
    case "vibration":
      return capability?.note ??
        "Keine Rauschmessung: Fliege eine längere gleichmäßige Strecke oder logge den Gyro mit gesunder Rate.";
    default:
      return capability?.note ?? null;
  }
}

// The short form for the card face: WHAT is missing, in three
// words; the advice above says what to do about it.
export function gapShort(key, capability) {
  const level = capability?.level ?? "missing";
  switch (key) {
    case "battery":
    case "power":
      return level === "missing"
        ? "Spannung"
        : "Strom (keine brauchbare Sensormessung)";
    case "rotor":
      return level === "missing" ? "Headspeed" : "Governor-Ziel";
    case "signal":
      return level === "missing"
        ? "Link-Telemetrie"
        : "Signalstärke (nur Empfänger-Flags)";
    case "bec":
      return "BEC-Spannung";
    case "vibration":
      return level === "missing" ? "Gyro-Rauschen" : "volles Rauschbild";
    default:
      return null;
  }
}

function capabilityFor(capabilities, key) {
  const name = CARD_CAPABILITY[key];
  return (
    (capabilities ?? []).find((entry) => entry.name === name) ?? null
  );
}

function unavailableCard(key, capability, { rotorMissing = false } = {}) {
  const spec = UNAVAILABLE_CARDS[key];
  if (!spec) return null;
  // Power and battery are read over steady flight, which is found
  // from rotor speed: with no headspeed logged THAT is the blocker,
  // not the current sensor.
  const rotorBlocked =
    rotorMissing && (key === "power" || key === "battery");
  const note = rotorBlocked
    ? "Wird im gleichmäßigen Flug gemessen, der an der Rotordrehzahl erkannt wird — und dieses Log enthält keine."
    : capability?.note ?? spec.fallbackNote ?? "Nicht geloggt.";
  const advice = rotorBlocked
    ? "Keine Headspeed geloggt: Ausgangsreserve und Akku-Zustand werden im gleichmäßigen Flug gelesen, der an der Rotordrehzahl erkannt wird. Aktiviere die RPM-Telemetrie, um sie freizuschalten."
    : gapAdvice(key, capability) ?? note;
  return {
    key,
    title: spec.title,
    status: "unavailable",
    // "not logged" when the channel is absent; "no reading" when
    // the channel exists but the flight gave nothing to measure.
    statusLabel: rotorBlocked
      ? "nicht messbar"
      : (capability?.level ?? "missing") === "missing"
        ? "nicht geloggt"
        : "keine Messung",
    headline: spec.headline,
    detail: note,
    action: advice,
    gap: note,
    gapAction: advice,
    screen: spec.screen,
    evidence: spec.evidence
  };
}

// A present card with a partial capability carries the gap as a
// line of its own — never inside the headline, never silently.
function withCapabilityGap(card, capability) {
  if (!card) return null;
  if (!capability || capability.level === "full") return card;
  if (card.status === "unavailable") return card;
  return {
    ...card,
    gap: capability.note,
    gapShort: gapShort(card.key, capability),
    gapAction: gapAdvice(card.key, capability)
  };
}

export function buildFlightVerdict({
  spectra,
  headspeed,
  governorTarget,
  vbat,
  pidAnalysis,
  labs,
  anchorHeadspeedRpm,
  filterAdvice = null,
  signalLab = null,
  becLab = null,
  capabilities = null
}) {
  // Peak naming needs the rotor speed the machine flew at. The
  // caller passes the stable-flight mean when one exists; the
  // tail-of-log average remains only as a fallback.
  const governedHeadspeed =
    (Number.isFinite(anchorHeadspeedRpm) && anchorHeadspeedRpm > 0
      ? anchorHeadspeedRpm
      : null) ??
    (headspeed
      ? averageOf(headspeed.slice(-Math.floor(headspeed.length / 3)))
      : null);

  const vibration = vibrationVerdict(
    spectra,
    governedHeadspeed,
    filterAdvice,
    pidAnalysis
  );

  // Every card slot is filled: a lab that measured speaks its
  // verdict (with its capability gap beside it when the log was
  // only partly there); a lab that could not measure says so, in
  // grey, on the same card — when capabilities are known. Without
  // the quality gate (older callers, tests) absent labs stay
  // absent, as before.
  const rotorMissing =
    capabilityFor(capabilities, "rotor")?.level === "missing";

  const slot = (key, card) => {
    const capability = capabilityFor(capabilities, key);
    if (card) {
      // A lab-born unavailable card (no RPM sensor, no steady
      // section) still states its gap for Home's list.
      if (card.status === "unavailable" && capabilities) {
        const filled = unavailableCard(key, capability, { rotorMissing });
        return {
          ...card,
          gap: card.gap ?? filled?.gap ?? null,
          gapAction: card.gapAction ?? filled?.gapAction ?? card.action ?? null
        };
      }
      return withCapabilityGap(card, capability);
    }
    return capabilities
      ? unavailableCard(key, capability, { rotorMissing })
      : null;
  };

  const cards = [
  slot("vibration", vibration),
  slot("rotor", rotorSpeedVerdictFromLab(labs?.governor)),
  tuningVerdict(pidAnalysis, {
    vibrationConcern: vibration?.status === "attention"
  }),
  slot("power", powerVerdictFromLab(labs?.esc)),
  slot("battery", batteryVerdictFromLab(labs?.battery)),
  slot("signal", signalVerdict(signalLab)),
  slot("bec", becVerdict(becLab))
].filter(Boolean);

  // Unavailable cards never color the flight: not-logged is not
  // unhealthy.
  const worst = cards.some((card) => card.status === "attention")
    ? "attention"
    : cards.some((card) => card.status === "watch")
      ? "watch"
      : "good";

  const summary =
    worst === "good"
      ? "Dieser Flug sieht gesund aus. Erkunde die Labore für die Details."
      : worst === "watch"
        ? "Überwiegend gesund, mit ein paar Dingen, die man im Auge behalten sollte."
        : "In diesem Flug wurde etwas gefunden, das deine Aufmerksamkeit verdient.";

  return { cards, worst, summary };
}
