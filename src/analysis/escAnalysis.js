function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}
function parseTargetRange(targetText) {
  if (!targetText) {
    return null;
  }

  const matches = targetText.match(
    /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/
  );

  if (!matches) {
    return null;
  }

  return {
    minimum: Number(matches[1]),
    maximum: Number(matches[2])
  };
}


function analyzeEscOutput(averageEscOutputRaw, profile) {
  if (averageEscOutputRaw === null) {
    return {
      score: 0,
      status: "Unavailable",
      finding: "ESC-Ausgangsdaten wurden nicht gefunden.",
      severity: "warning"
    };
  }

  const averagePercent = averageEscOutputRaw / 10;
  const targetRange = parseTargetRange(
    profile ? profile.targetEscOutput : null
  );

  if (!targetRange) {
    return {
      score: 70,
      status: "Detected",
      finding:
        `Die durchschnittliche ESC-Ausgabe lag bei ${averagePercent.toFixed(1)} %, ` +
        "aber es ist kein Zielbereich für das Fluggerät verfügbar.",
      severity: "info"
    };
  }

  const minimum = targetRange.minimum;
  const maximum = targetRange.maximum;

  if (
    averagePercent >= minimum &&
    averagePercent <= maximum
  ) {
    return {
      score: 100,
      status: "Excellent",
      finding:
        `Die durchschnittliche ESC-Ausgabe lag bei ${averagePercent.toFixed(1)} %, ` +
        `innerhalb des Ziels des Fluggeräts von ${minimum}-${maximum} %.`,
      severity: "good"
    };
  }

  const distanceBelow = minimum - averagePercent;
  const distanceAbove = averagePercent - maximum;
  const distance = Math.max(distanceBelow, distanceAbove);

  if (distance <= 3) {
    return {
      score: 90,
      status: "Very Good",
      finding:
        `Die durchschnittliche ESC-Ausgabe lag bei ${averagePercent.toFixed(1)} %, ` +
        `leicht außerhalb des bevorzugten Bereichs von ${minimum}-${maximum} %.`,
      severity: "good"
    };
  }

  if (distance <= 7) {
    return {
      score: 75,
      status: "Acceptable",
      finding:
        `Die durchschnittliche ESC-Ausgabe lag bei ${averagePercent.toFixed(1)} %. ` +
        `Der bevorzugte Bereich ist ${minimum}-${maximum} %.`,
      severity: "caution"
    };
  }

  return {
    score: 50,
    status: "Needs Review",
    finding:
      `Die durchschnittliche ESC-Ausgabe lag bei ${averagePercent.toFixed(1)} %, ` +
      `deutlich außerhalb des bevorzugten Bereichs von ${minimum}-${maximum} %.`,
    severity: "warning"
  };
}export { analyzeEscOutput };