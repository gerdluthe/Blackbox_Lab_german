function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}


function getStandardDeviation(values) {
  if (!values || values.length === 0) {
    return null;
  }

  const average =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

  const variance =
    values.reduce((sum, value) => {
      const difference = value - average;
      return sum + difference * difference;
    }, 0) / values.length;

  return Math.sqrt(variance);
}


 function analyzeGovernor(
  headspeedValues,
  governorTargetValues
) {
  if (
    headspeedValues.length === 0 ||
    governorTargetValues.length === 0
  ) {
    return {
      score: 0,
      status: "Unavailable",
      averageHeadspeed: null,
      averageTarget: null,
      averageError: null,
      variation: null,
      finding:
        "Headspeed- oder Governor-Ziel-Daten waren nicht verfügbar."
    };
  }

  const sampleCount = Math.min(
    headspeedValues.length,
    governorTargetValues.length
  );

  const validSamples = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const headspeed = headspeedValues[index];
    const target = governorTargetValues[index];

    if (
      Number.isFinite(headspeed) &&
      Number.isFinite(target) &&
      headspeed > 500 &&
      target > 500
    ) {
      validSamples.push({
        headspeed,
        target
      });
    }
  }

  if (validSamples.length === 0) {
    return {
      score: 0,
      status: "No Active Flight Data",
      averageHeadspeed: null,
      averageTarget: null,
      averageError: null,
      variation: null,
      finding:
        "Governor-Spalten wurden gefunden, aber es wurden keine aktiven Governor-Flug-Samples erkannt."
    };
  }

  const activeHeadspeeds = validSamples.map(
    (sample) => sample.headspeed
  );

  const averageHeadspeed =
    activeHeadspeeds.reduce(
      (sum, value) => sum + value,
      0
    ) / activeHeadspeeds.length;

  const averageTarget =
    validSamples.reduce(
      (sum, sample) => sum + sample.target,
      0
    ) / validSamples.length;

  const averageAbsoluteError =
    validSamples.reduce(
      (sum, sample) =>
        sum + Math.abs(sample.headspeed - sample.target),
      0
    ) / validSamples.length;

  const variation =
    getStandardDeviation(activeHeadspeeds);

  const errorPercent =
    averageTarget > 0
      ? (averageAbsoluteError / averageTarget) * 100
      : 100;

  const variationPercent =
    averageHeadspeed > 0 && variation !== null
      ? (variation / averageHeadspeed) * 100
      : 100;

  let score = 100;

  score -= errorPercent * 8;
  score -= variationPercent * 10;
  score = clampScore(score);

  let status = "Excellent";

  if (score < 95) {
    status = "Very Good";
  }

  if (score < 85) {
    status = "Good";
  }

  if (score < 70) {
    status = "Fair";
  }

  if (score < 55) {
    status = "Needs Review";
  }

  return {
    score,
    status,
    averageHeadspeed,
    averageTarget,
    averageError: averageAbsoluteError,
    variation,
    finding:
      `Die mittlere Headspeed lag bei ${Math.round(averageHeadspeed)} U/min ` +
      `gegenüber einem mittleren Ziel von ${Math.round(averageTarget)} U/min. ` +
      `Der mittlere Nachführfehler war ${averageAbsoluteError.toFixed(1)} U/min ` +
      `und die Headspeed-Schwankung war ${variation.toFixed(1)} U/min.`
  };
}

export { analyzeGovernor };
