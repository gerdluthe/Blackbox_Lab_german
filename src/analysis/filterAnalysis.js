// ====================================================
// BLACKBOX LAB - FILTER ANALYSIS
// ====================================================
import {
  columnTableFor,
  alignedColumnValues,
  finiteValuesAtRows
} from "./columnTable.js";
import {
  detectStableFlightPhase
} from "./flightPhase.js";

// Remaining filtered gyro level, averaged across the axes, at which a
// headspeed profile stops reading as clean. One home for the two
// numbers: the per-profile status and the score's view of whether
// vibration still matters have to agree, or a page can call a profile
// "Monitor" and score it as though nothing were wrong.
const PROFILE_MONITOR_LEVEL = 12;
const PROFILE_REVIEW_LEVEL = 16;

// Below this average reduction, filtering is doing very little. On a
// quiet machine that is the right answer; alongside real vibration it
// is a finding.
const LOW_REDUCTION_PERCENT = 15;

// Remaining vibration high enough to be worth deducting for.
//
// Measured against the contributed fleet rather than chosen: the
// fleet's per-profile filtered level runs a median of 15.5 and an
// upper quartile of 30.5. Deducting from PROFILE_MONITOR_LEVEL would
// charge the median helicopter for being ordinary, which tells a pilot
// nothing — the same failure as scoring every readable log 100, just
// at the other end.
const VIBRATION_ELEVATED = 16;
const VIBRATION_HIGH = 30;

/**
 * What the filter analysis could not settle, and what each of those
 * costs the score.
 *
 * A score built only from how many column groups were detected reaches
 * 100 on any readable log, including one whose own findings report an
 * unexplained peak or filters removing almost nothing. This is the
 * part that reads those findings back.
 *
 * @param unmatchedPeakCount  raw peaks matching no known aircraft
 *                            frequency — unexplained shake
 * @param averageReduction    percent gyro noise removed by filtering
 * @param remainingVibration  filtered gyro level left afterwards
 */
export function assessUnresolvedFindings({
  unmatchedPeakCount = 0,
  matchedPeakCount = 0,
  averageReduction = null,
  remainingVibration = null,
  lowFrequencyPeakCount = 0
} = {}) {
  // Filters removing little on an already-quiet machine is correct,
  // not a fault. Filters removing little while real vibration remains
  // is the fault. Everything below turns on that distinction — with
  // one more: when the vibration sits below the filter band (~20 Hz),
  // "the filters removed little" is filters behaving correctly, and
  // charging the filter score for it points the pilot at the wrong
  // part of the machine.
  const vibrationStillMatters =
    Number.isFinite(remainingVibration) &&
    remainingVibration >= VIBRATION_ELEVATED;

  const vibrationIsHigh =
    Number.isFinite(remainingVibration) &&
    remainingVibration >= VIBRATION_HIGH;

  const filtersAreIneffective =
    Number.isFinite(averageReduction) &&
    averageReduction < LOW_REDUCTION_PERCENT &&
    vibrationStillMatters &&
    lowFrequencyPeakCount === 0;

  const findings = [];

  if (
    lowFrequencyPeakCount > 0 &&
    Number.isFinite(averageReduction) &&
    averageReduction < LOW_REDUCTION_PERCENT &&
    vibrationStillMatters
  ) {
    // Named, but free: the score answers for filter quality, and
    // filters not removing sub-band vibration is correct behavior.
    // The vibration itself is still charged below.
    findings.push({
      reason:
        "Geringe Gesamtreduktion bei gleichzeitiger Spitze unterhalb des ~20-Hz-Filterbands: Diese Vibration ist strukturell, und Filter tun gut daran, sie nicht anzufassen. Die Lösung liegt an der Werkbank, nicht in den Filter-Einstellungen.",
      cost: 0
    });
  }

  // A peak matching nothing known is only evidence of unexplained
  // vibration when the matcher is otherwise finding things. Across the
  // contributed fleet most flights match nothing at all, so on its own
  // "unmatched" reports the matcher's reach, not the machine's health,
  // and a pilot must not be marked down for it.
  if (unmatchedPeakCount > 0 && matchedPeakCount > 0) {
    findings.push({
      reason:
        unmatchedPeakCount === 1
          ? "Eine Vibrationsspitze passte zu keiner bekannten Drehfrequenz dieser Maschine."
          : `${unmatchedPeakCount} Vibrationsspitzen passten zu keiner bekannten Drehfrequenz dieser Maschine.`,
      cost: Math.min(10, unmatchedPeakCount * 5)
    });
  }

  if (filtersAreIneffective) {
    findings.push({
      reason: `Die Filterung reduzierte das Gyro-Rauschen nur um ${averageReduction.toFixed( 1 )} %, während die Vibration hoch blieb.`,
      cost: 15
    });
  }

  if (vibrationIsHigh) {
    findings.push({
      reason:
        "Die Vibration nach der Filterung ist im Vergleich zu den meisten Maschinen hoch.",
      cost: 20
    });
  } else if (vibrationStillMatters && !filtersAreIneffective) {
    findings.push({
      reason:
        "Die Vibration bleibt nach der Filterung auf einem Niveau, das Beobachtung verdient.",
      cost: 8
    });
  }

  return {
    findings,
    penalty: findings.reduce((total, finding) => total + finding.cost, 0),
    vibrationStillMatters,
    vibrationIsHigh,
    filtersAreIneffective
  };
}

function findMatchingColumns(columns, patterns) {
  if (!Array.isArray(columns)) {
    return [];
  }

  return columns.filter((columnName) => {
    const normalizedName = String(columnName).toLowerCase();

    return patterns.some((pattern) =>
      normalizedName.includes(pattern)
    );
  });
}
function extractNumericColumnValues(
  lines,
  headerIndex,
  columnName,
  sampleStep = 10
) {
  if (
    !Array.isArray(lines) ||
    !Number.isInteger(headerIndex) ||
    headerIndex < 0 ||
    !columnName
  ) {
    return [];
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) => header.trim());

  const columnIndex = headers.indexOf(columnName);

  if (columnIndex < 0) {
    return [];
  }

  const values = [];
  const column = columnTableFor(lines, headerIndex)?.column(columnIndex);

  if (!column) {
    return values;
  }

  for (
    let rowIndex = headerIndex + 1;
    rowIndex < lines.length;
    rowIndex += sampleStep
  ) {
    const value = column[rowIndex];

    if (Number.isFinite(value)) {
      values.push(value);
    }
  }

  return values;
}
function calculateAverageAbsolute(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const total = values.reduce(
    (sum, value) => sum + Math.abs(value),
    0
  );

  return total / values.length;
}
function estimateSampleRate(lines, headerIndex) {
  if (
    !Array.isArray(lines) ||
    !Number.isInteger(headerIndex) ||
    headerIndex < 0
  ) {
    return null;
  }

  const headers = lines[headerIndex]
  .split(",")
  .map((header) =>
    header
      .trim()
      .replace(/^"|"$/g, "")
  );

  const timeColumnIndex = headers.indexOf("time");

  if (timeColumnIndex < 0) {
    return null;
  }

  const timeValues = [];

  const lastRow = Math.min(
    lines.length,
    headerIndex + 5001
  );

  const timeColumn =
    columnTableFor(lines, headerIndex)?.column(timeColumnIndex) ?? null;

  for (
    let rowIndex = headerIndex + 1;
    timeColumn && rowIndex < lastRow;
    rowIndex += 1
  ) {
    const timeValue = timeColumn[rowIndex];

    if (Number.isFinite(timeValue)) {
      timeValues.push(timeValue);
    }
  }

  if (timeValues.length < 2) {
    return null;
  }

  const intervals = [];

  for (let index = 1; index < timeValues.length; index += 1) {
    const interval =
      timeValues[index] - timeValues[index - 1];

    if (interval > 0) {
      intervals.push(interval);
    }
  }

  if (intervals.length === 0) {
    return null;
  }

  intervals.sort((a, b) => a - b);

  const middleIndex = Math.floor(intervals.length / 2);

  const medianInterval =
    intervals.length % 2 === 0
      ? (
          intervals[middleIndex - 1] +
          intervals[middleIndex]
        ) / 2
      : intervals[middleIndex];

  const intervalSeconds = medianInterval / 1_000_000;

  return {
    sampleRateHz: 1 / intervalSeconds,
    medianIntervalMicroseconds: medianInterval,
    sampleCount: timeValues.length
  };
}
function extractContiguousNumericWindow(
  lines,
  headerIndex,
  columnName,
  windowSize = 4096,
  startOffset = 0
) {
  if (
    !Array.isArray(lines) ||
    !Number.isInteger(headerIndex) ||
    headerIndex < 0 ||
    !columnName
  ) {
    return [];
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) =>
      header
        .trim()
        .replace(/^"|"$/g, "")
    );

  const cleanColumnName = String(columnName)
    .trim()
    .replace(/^"|"$/g, "");

  const columnIndex =
    headers.indexOf(cleanColumnName);

  if (columnIndex < 0) {
    return [];
  }

  const values = [];

  const firstDataRow =
    headerIndex + 1 + startOffset;

  const lastDataRow = Math.min(
    lines.length,
    firstDataRow + windowSize
  );

  const windowColumn =
    columnTableFor(lines, headerIndex)?.column(columnIndex) ?? null;

  for (
    let rowIndex = firstDataRow;
    windowColumn && rowIndex < lastDataRow;
    rowIndex += 1
  ) {
    const value = windowColumn[rowIndex];

    if (!Number.isFinite(value)) {
      return [];
    }

    values.push(value);
  }

  return values.length === windowSize
    ? values
    : [];
}
function extractAlignedNumericColumn(
  lines,
  headerIndex,
  columnPatterns
) {
  if (
    !Array.isArray(lines) ||
    !Number.isInteger(headerIndex) ||
    headerIndex < 0 ||
    !Array.isArray(columnPatterns)
  ) {
    return {
      columnName: null,
      values: []
    };
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) =>
      header
        .trim()
        .replace(/^"|"$/g, "")
    );

  const columnIndex = headers.findIndex((header) =>
    columnPatterns.some((pattern) =>
      pattern.test(header)
    )
  );

  if (columnIndex < 0) {
    return {
      columnName: null,
      values: []
    };
  }

  const values = alignedColumnValues(lines, headerIndex, columnIndex);

  return {
    columnName: headers[columnIndex],
    values
  };
}
function calculateMagnitudeSpectrum(values, sampleRateHz) {
  if (
    !Array.isArray(values) ||
    values.length < 2 ||
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz <= 0
  ) {
    return [];
  }

  const size = values.length;

  if ((size & (size - 1)) !== 0) {
    return [];
  }

  const average =
    values.reduce((sum, value) => sum + value, 0) / size;

  const real = new Array(size);
  const imaginary = new Array(size).fill(0);

  for (let index = 0; index < size; index += 1) {
    const hannWindow =
      0.5 -
      0.5 *
        Math.cos(
          (2 * Math.PI * index) /
          (size - 1)
        );

    real[index] =
      (values[index] - average) * hannWindow;
  }

  // Bit-reversal ordering
  for (
    let index = 1, reversedIndex = 0;
    index < size;
    index += 1
  ) {
    let bit = size >> 1;

    while (reversedIndex & bit) {
      reversedIndex ^= bit;
      bit >>= 1;
    }

    reversedIndex ^= bit;

    if (index < reversedIndex) {
      [real[index], real[reversedIndex]] =
        [real[reversedIndex], real[index]];

      [imaginary[index], imaginary[reversedIndex]] =
        [imaginary[reversedIndex], imaginary[index]];
    }
  }

  // Radix-2 FFT
  for (
    let blockSize = 2;
    blockSize <= size;
    blockSize <<= 1
  ) {
    const angleStep =
      (-2 * Math.PI) / blockSize;

    const halfBlock = blockSize >> 1;

    for (
      let blockStart = 0;
      blockStart < size;
      blockStart += blockSize
    ) {
      for (
        let offset = 0;
        offset < halfBlock;
        offset += 1
      ) {
        const angle = angleStep * offset;

        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);

        const evenIndex =
          blockStart + offset;

        const oddIndex =
          evenIndex + halfBlock;

        const oddReal =
          real[oddIndex] * cosine -
          imaginary[oddIndex] * sine;

        const oddImaginary =
          real[oddIndex] * sine +
          imaginary[oddIndex] * cosine;

        const evenReal = real[evenIndex];
        const evenImaginary =
          imaginary[evenIndex];

        real[evenIndex] =
          evenReal + oddReal;

        imaginary[evenIndex] =
          evenImaginary + oddImaginary;

        real[oddIndex] =
          evenReal - oddReal;

        imaginary[oddIndex] =
          evenImaginary - oddImaginary;
      }
    }
  }

  const spectrum = [];
  const nyquistBin = size / 2;

  for (
    let binIndex = 1;
    binIndex <= nyquistBin;
    binIndex += 1
  ) {
    spectrum.push({
      frequencyHz:
        (binIndex * sampleRateHz) / size,

      magnitude:
        Math.hypot(
          real[binIndex],
          imaginary[binIndex]
        ) / size
    });
  }

  return spectrum;
}

function findStrongestFrequency(
  spectrum,
  minimumFrequencyHz = 5
) {
  if (!Array.isArray(spectrum)) {
    return null;
  }

  const usableBins = spectrum.filter(
    (bin) =>
      Number.isFinite(bin.frequencyHz) &&
      Number.isFinite(bin.magnitude) &&
      bin.frequencyHz >= minimumFrequencyHz
  );

  if (usableBins.length === 0) {
    return null;
  }

  return usableBins.reduce(
    (strongest, bin) =>
      bin.magnitude > strongest.magnitude
        ? bin
        : strongest
  );
  }function buildAircraftFrequencyMap(
  analysisContext,
  headspeedOverride = null
) {
  
  const profile =
    analysisContext?.aircraft?.profile || {};

  const averageHeadspeed =
  Number.isFinite(headspeedOverride) &&
  headspeedOverride > 0
    ? headspeedOverride
    : analysisContext?.flight?.averageHeadspeed;

  const mainBladeCount =
    Number(profile.mainBladeCount);

  const tailBladeCount =
    Number(profile.tailBladeCount);

  const tailRatio =
    Number(profile.tailRatio);

  const mainGearRatio =
    Number(profile.mainGearRatio);

  const motorPoleCount =
    Number(profile.motorPoleCount);

  if (
    !Number.isFinite(averageHeadspeed) ||
    averageHeadspeed <= 0
  ) {
    return null;
  }

  const mainRotorHz =
    averageHeadspeed / 60;

  const mainBladePassHz =
    Number.isFinite(mainBladeCount)
      ? mainRotorHz * mainBladeCount
      : null;

  const tailRotorHz =
    Number.isFinite(tailRatio)
      ? mainRotorHz * tailRatio
      : null;

  const tailBladePassHz =
    Number.isFinite(tailRotorHz) &&
    Number.isFinite(tailBladeCount)
      ? tailRotorHz * tailBladeCount
      : null;

  const motorMechanicalHz =
    Number.isFinite(mainGearRatio)
      ? mainRotorHz * mainGearRatio
      : null;

  const motorElectricalHz =
    Number.isFinite(motorMechanicalHz) &&
    Number.isFinite(motorPoleCount)
      ? motorMechanicalHz *
        (motorPoleCount / 2)
      : null;

  return {
    averageHeadspeed,
    mainRotorHz,
    mainBladePassHz,
    tailRotorHz,
    tailBladePassHz,
    motorMechanicalHz,
    motorElectricalHz
  };
}
function findClosestAircraftFrequencyMatch(
  peakFrequencyHz,
  aircraftFrequencyMaps
) {
  if (
    !Number.isFinite(peakFrequencyHz) ||
    !Array.isArray(aircraftFrequencyMaps)
  ) {
    return null;
  }

  const frequencyNames = [
    "mainRotorHz",
    "mainBladePassHz",
    "tailRotorHz",
    "tailBladePassHz",
    "motorMechanicalHz",
    "motorElectricalHz"
  ];

  let closestMatch = null;

  for (const profileMap of aircraftFrequencyMaps) {
    const frequencies = profileMap?.frequencies;

    if (!frequencies) {
      continue;
    }

    for (const frequencyName of frequencyNames) {
      const expectedFrequencyHz =
        frequencies[frequencyName];

      if (!Number.isFinite(expectedFrequencyHz)) {
        continue;
      }

      const differenceHz = Math.abs(
        peakFrequencyHz - expectedFrequencyHz
      );

      const toleranceHz = Math.max(
        2,
        expectedFrequencyHz * 0.03
      );

      const candidateMatch = {
        frequencyName,
        peakFrequencyHz,
        expectedFrequencyHz,
        differenceHz,
        toleranceHz,
        isWithinTolerance:
          differenceHz <= toleranceHz,
        targetRpm: profileMap.targetRpm,
        averageRpm: profileMap.averageRpm
      };

      if (
        !closestMatch ||
        candidateMatch.differenceHz <
          closestMatch.differenceHz
      ) {
        closestMatch = candidateMatch;
      }
    }
  }

  return closestMatch;
}
export function analyzeFilters(
  analysisContext,
  lines = []
) {
  const unavailableResult = {
    score: 0,
    status: "Insufficient Data",
    severity: "unknown",
    confidence: {
      score: 0,
      label: "Low"
    },
    findings: [
      "Die Filter-Analyse benötigt Gyro- und PID-bezogene Blackbox-Daten."
    ],
    recommendations: [],
    evidence: []
  };

  if (!analysisContext) {
    return unavailableResult;
  }

  const evidenceSources =
    analysisContext.evidence?.sources || {};

  const allColumns =
    analysisContext.telemetry?.allColumns || [];

  const hasBlackboxLog =
    evidenceSources.bbl === true;

  const rawGyroColumns = findMatchingColumns(
    allColumns,
    [
  "gyroraw",
  "rawgyro",
  "gyro_raw"
    ]   
  );

  const filteredGyroColumns = findMatchingColumns(
    allColumns,
    [
      "gyroadc",
      "gyrofiltered",
      "filteredgyro",
      "gyro_filter",
      "gyrofilter",
      "gyro["
    ]
  ).filter(
    (columnName) =>
      !rawGyroColumns.includes(columnName)
  );

  const setpointColumns = findMatchingColumns(
    allColumns,
    [
      "setpoint",
      "axiscommand",
      "axiscommandf",
      "rccommand"
    ]
  );

  const pidColumns = findMatchingColumns(
    allColumns,
    [
      "axisp",
      "axisi",
      "axisd",
      "axisf",
      "axispd",
      "axiserror",
      "pid"
    ]
  );
const setpointAxisColumns = [0, 1, 2].map((axisIndex) =>
  setpointColumns.find(
    (column) =>
      column
        .replaceAll('"', "")
        .trim()
        .toLowerCase() === `setpoint[${axisIndex}]`
  )
);
const axisErrorColumns = [0, 1, 2].map((axisIndex) =>
  pidColumns.find(
    (column) =>
      column
        .replaceAll('"', "")
        .trim()
        .toLowerCase() === `axiserror[${axisIndex}]`
  )
);
  const motorOutputColumns = findMatchingColumns(
    allColumns,
    [
      "motor",
      "escoutput",
      "escthr",
      "throttle"
    ]
  );

  const detectedGroups = {
    rawGyro: rawGyroColumns,
    filteredGyro: filteredGyroColumns,
    setpoint: setpointColumns,
    pid: pidColumns,
    motorOutput: motorOutputColumns
  };
const telemetryHeaderIndex =
  analysisContext.flight?.telemetryHeaderIndex;
  const timeColumn = extractAlignedNumericColumn(
  lines,
  telemetryHeaderIndex,
  [/^time$/i]
);

const headspeedColumn = extractAlignedNumericColumn(
  lines,
  telemetryHeaderIndex,
  [/headspeed/i, /^rpm$/i]
);

const governorTargetColumn = extractAlignedNumericColumn(
  lines,
  telemetryHeaderIndex,
  [/governortarget/i, /govtarget/i]
);

const firstTimeMicroseconds =
  timeColumn.values.find(Number.isFinite) ?? 0;

const timeSeconds = timeColumn.values.map((value) =>
  Number.isFinite(value)
    ? (value - firstTimeMicroseconds) / 1_000_000
    : null
);

// Aircraft without an RPM sensor log headspeed as zero, so
// airframe motion is offered as a second way to find the
// flight section. It is only used when rotor speed is absent.
const activityGyroColumns = [
  extractAlignedNumericColumn(lines, telemetryHeaderIndex, [
    /^gyroadc\[0\]$/i,
    /^gyroraw\[0\]$/i
  ]),
  extractAlignedNumericColumn(lines, telemetryHeaderIndex, [
    /^gyroadc\[1\]$/i,
    /^gyroraw\[1\]$/i
  ]),
  extractAlignedNumericColumn(lines, telemetryHeaderIndex, [
    /^gyroadc\[2\]$/i,
    /^gyroraw\[2\]$/i
  ])
].filter((column) => column.values.length > 0);

const motionActivity =
  activityGyroColumns.length > 0
    ? timeSeconds.map((_, index) =>
        activityGyroColumns.reduce((total, column) => {
          const value = Number(column.values[index]);

          return (
            total + (Number.isFinite(value) ? Math.abs(value) : 0)
          );
        }, 0)
      )
    : [];

const stableFlightPhase = detectStableFlightPhase({
  timeSeconds,
  headspeed: headspeedColumn.values,
  governorTarget: governorTargetColumn.values,
  activity: motionActivity
});

const sampleRate =
  estimateSampleRate(
    lines,
    telemetryHeaderIndex
  );
  ;
  const aircraftFrequencyMap =
  buildAircraftFrequencyMap(
    analysisContext
  );
const headspeedProfiles =
  analysisContext?.flight?.headspeedProfiles || [];
  function getProfileColumnValues(
  lines,
  headerIndex,
  columnName,
  sampleIndexes
) {
  if (
    !Array.isArray(lines) ||
    !Number.isInteger(headerIndex) ||
    headerIndex < 0 ||
    !columnName ||
    !Array.isArray(sampleIndexes)
  ) {
    return [];
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) => header.trim());

  const columnIndex = headers.indexOf(columnName);

  if (columnIndex < 0) {
    return [];
  }

  return finiteValuesAtRows(lines, headerIndex, columnIndex, sampleIndexes);
}

 function buildProfileMechanicalFinding({
  targetRpm,
  sampleCount,
  roll,
  pitch,
  yaw
}) {
  const axes = [
    { name: "Roll", data: roll },
    { name: "Pitch", data: pitch },
    { name: "Yaw", data: yaw }
  ].filter(
    (axis) =>
      axis.data &&
      Number.isFinite(axis.data.rawAverage) &&
      Number.isFinite(axis.data.filteredAverage)
  );

  if (axes.length === 0) {
    return {
      status: "Insufficient Data",
      summary:
        `Nicht genug Gyro-Daten verfügbar, um das Profil mit ${targetRpm} U/min auszuwerten.`,
      strongestAxis: null
    };
  }

  const strongestAxis = axes.reduce(
    (highest, current) =>
      current.data.filteredAverage >
      highest.data.filteredAverage
        ? current
        : highest
  );

  const averageFiltered =
    axes.reduce(
      (total, axis) =>
        total + axis.data.filteredAverage,
      0
    ) / axes.length;

  let status = "Cleanest Profile";

if (averageFiltered >= PROFILE_REVIEW_LEVEL) {
  status = "Needs Review";
} else if (averageFiltered >= PROFILE_MONITOR_LEVEL) {
  status = "Monitor";
}
  let confidence = "Low";

if (sampleCount >= 5000) {
  confidence = "High";
} else if (sampleCount >= 1500) {
  confidence = "Moderate";

}
const controlMotionAxes = [
  { name: "Roll", data: roll },
  { name: "Pitch", data: pitch },
  { name: "Yaw", data: yaw }
].filter(
  (axis) =>
    Number.isFinite(axis.data?.setpointAverage) &&
    Number.isFinite(axis.data?.axisErrorAverage)
);

let controlMotionAssessment =
  "Belege zur Steuerbewegung waren für dieses Profil nicht verfügbar.";
let controlMotionConcern = null;

if (controlMotionAxes.length > 0) {
  const controlRatios = controlMotionAxes
    .map((axis) => {
      const setpointAverage = axis.data.setpointAverage;
      const axisErrorAverage = axis.data.axisErrorAverage;

      if (setpointAverage <= 0) {
        return null;
      }

      return {
        axis: axis.name,
        ratio: axisErrorAverage / setpointAverage
      };
    })
    .filter(Boolean);

  if (controlRatios.length > 0) {
    const highestControlRatio = controlRatios.reduce(
      (highest, current) =>
        current.ratio > highest.ratio ? current : highest
    );

    controlMotionConcern =
      highestControlRatio.ratio >= 0.5
        ? "high"
        : highestControlRatio.ratio >= 0.25
          ? "moderate"
          : "none";

    if (highestControlRatio.ratio >= 0.5) {
      controlMotionAssessment =
        `${highestControlRatio.axis} zeigt in den verfügbaren Samples der kommandierten Bewegung ein hohes Regelfehler-Verhältnis. Das weist auf ein Nachführungs-Problem hin, aber das Filter-Labor kann allein nicht bestimmen, ob die Ursache die Filterung, die PID-Balance, die Mechanik oder die Mischung der Kommando-Ereignisse ist. Prüfe gegen das PID-Labor, bevor du Filter-Einstellungen änderst.`;
    } else if (highestControlRatio.ratio >= 0.25) {
      controlMotionAssessment =
        `${highestControlRatio.axis} zeigt in den verfügbaren Samples der kommandierten Bewegung ein mäßiges Regelfehler-Verhältnis. Verfolge das zusammen mit dem PID-Labor und mechanischen Belegen, bevor du es den Filtern zuschreibst.`;
    } else {
      controlMotionAssessment =
        "Setpoint- und Achsenfehler-Daten zeigen, dass die kommandierte Bewegung nachgeführt wird, ohne offensichtliche Belege dafür, dass nützliche Steuerbewegung entfernt würde.";
    }
  }
}
  return {
    status,
    confidence,
sampleCount,
controlMotionAssessment,
controlMotionConcern,
    controlMotionAvailable: controlMotionAxes.length > 0,
    strongestAxis: strongestAxis.name,
    strongestFilteredAverage:
      strongestAxis.data.filteredAverage,
    averageFiltered,
    summary:
      `${targetRpm} RPM is rated ${status} with ${confidence} confidence from ${sampleCount} samples. ` +
      `${strongestAxis.name} hat die höchste verbleibende gefilterte Vibration.`
  };
}

const profileSpecificFilterAnalysis = [];

for (const profile of headspeedProfiles) {
  const rollRawValues = getProfileColumnValues(
    lines,
    telemetryHeaderIndex,
    rawGyroColumns[0],
    profile.sampleIndexes
  );

  const rollFilteredValues = getProfileColumnValues(
    lines,
    telemetryHeaderIndex,
    filteredGyroColumns[0],
    profile.sampleIndexes
  );

  const rollRawAverage =
    calculateAverageAbsolute(rollRawValues);

  const rollFilteredAverage =
    calculateAverageAbsolute(rollFilteredValues);

  const rollReductionPercent =
    Number.isFinite(rollRawAverage) &&
    rollRawAverage > 0 &&
    Number.isFinite(rollFilteredAverage)
      ? ((rollRawAverage - rollFilteredAverage) /
          rollRawAverage) *
        100
      : null;

  const pitchRawValues = getProfileColumnValues(
    lines,
    telemetryHeaderIndex,
    rawGyroColumns[1],
    profile.sampleIndexes
  );

  const pitchFilteredValues = getProfileColumnValues(
    lines,
    telemetryHeaderIndex,
    filteredGyroColumns[1],
    profile.sampleIndexes
  );

  const pitchRawAverage =
    calculateAverageAbsolute(pitchRawValues);

  const pitchFilteredAverage =
    calculateAverageAbsolute(pitchFilteredValues);

  const pitchReductionPercent =
    Number.isFinite(pitchRawAverage) &&
    pitchRawAverage > 0 &&
    Number.isFinite(pitchFilteredAverage)
      ? ((pitchRawAverage - pitchFilteredAverage) /
          pitchRawAverage) *
        100
      : null;

  const yawRawValues = getProfileColumnValues(
    lines,
    telemetryHeaderIndex,
    rawGyroColumns[2],
    profile.sampleIndexes
  );

  const yawFilteredValues = getProfileColumnValues(
    lines,
    telemetryHeaderIndex,
    filteredGyroColumns[2],
    profile.sampleIndexes
  );

  const yawRawAverage =
    calculateAverageAbsolute(yawRawValues);

  const yawFilteredAverage =
    calculateAverageAbsolute(yawFilteredValues);

  const yawReductionPercent =
    Number.isFinite(yawRawAverage) &&
    yawRawAverage > 0 &&
    Number.isFinite(yawFilteredAverage)
      ? ((yawRawAverage - yawFilteredAverage) /
          yawRawAverage) *
        100
      : null;
const rollSetpointValues =
  setpointAxisColumns[0]
    ? getProfileColumnValues(
        lines,
        telemetryHeaderIndex,
        setpointAxisColumns[0],
        profile.sampleIndexes
      )
    : [];

const rollAxisErrorValues =
  axisErrorColumns[0]
    ? getProfileColumnValues(
        lines,
        telemetryHeaderIndex,
        axisErrorColumns[0],
        profile.sampleIndexes
      )
    : [];

const rollSetpointAverage =
  calculateAverageAbsolute(rollSetpointValues);

const rollAxisErrorAverage =
  calculateAverageAbsolute(rollAxisErrorValues);
  const pitchSetpointValues =
  setpointAxisColumns[1]
    ? getProfileColumnValues(
        lines,
        telemetryHeaderIndex,
        setpointAxisColumns[1],
        profile.sampleIndexes
      )
    : [];

const pitchAxisErrorValues =
  axisErrorColumns[1]
    ? getProfileColumnValues(
        lines,
        telemetryHeaderIndex,
        axisErrorColumns[1],
        profile.sampleIndexes
      )
    : [];

const yawSetpointValues =
  setpointAxisColumns[2]
    ? getProfileColumnValues(
        lines,
        telemetryHeaderIndex,
        setpointAxisColumns[2],
        profile.sampleIndexes
      )
    : [];

const yawAxisErrorValues =
  axisErrorColumns[2]
    ? getProfileColumnValues(
        lines,
        telemetryHeaderIndex,
        axisErrorColumns[2],
        profile.sampleIndexes
      )
    : [];

const pitchSetpointAverage =
  calculateAverageAbsolute(pitchSetpointValues);

const pitchAxisErrorAverage =
  calculateAverageAbsolute(pitchAxisErrorValues);

const yawSetpointAverage =
  calculateAverageAbsolute(yawSetpointValues);

const yawAxisErrorAverage =
  calculateAverageAbsolute(yawAxisErrorValues);
  const roll = {
    setpointAverage: rollSetpointAverage,
axisErrorAverage: rollAxisErrorAverage,
    rawAverage: rollRawAverage,
    filteredAverage: rollFilteredAverage,
    reductionPercent: rollReductionPercent
  };

  const pitch = {
    setpointAverage: pitchSetpointAverage,
axisErrorAverage: pitchAxisErrorAverage,
    rawAverage: pitchRawAverage,
    filteredAverage: pitchFilteredAverage,
    reductionPercent: pitchReductionPercent
  };

  const yaw = {
    setpointAverage: yawSetpointAverage,
axisErrorAverage: yawAxisErrorAverage,
    rawAverage: yawRawAverage,
    filteredAverage: yawFilteredAverage,
    reductionPercent: yawReductionPercent
  };

  profileSpecificFilterAnalysis.push({
    targetRpm: profile.targetRpm,
    averageRpm: profile.averageRpm,
    sampleCount: profile.sampleCount,
    sampleIndexes: profile.sampleIndexes,
    roll,
    pitch,
    yaw,
    mechanicalFinding:
     buildProfileMechanicalFinding({
  targetRpm: profile.targetRpm,
  sampleCount: profile.sampleCount,
  roll,
  pitch,
  yaw
})
  });
  }

// "Cleanest" is a placing, and a placing needs a field. A flight flown
// at one headspeed has nothing to be cleanest against, so the profile
// is described as the one that was measured. Only the clean label is
// comparative — a profile that earns "Monitor" or "Needs Review" earns
// it on its own reading, so those stand however many profiles there
// are, and the score reads the same statuses as before.
if (profileSpecificFilterAnalysis.length === 1) {
  const onlyProfile = profileSpecificFilterAnalysis[0];

  if (onlyProfile.mechanicalFinding?.status === "Cleanest Profile") {
    onlyProfile.mechanicalFinding.status = "Only Profile Measured";

    // The summary sentence was baked with the comparative word —
    // it must tell the same story as the status it carries.
    if (typeof onlyProfile.mechanicalFinding.summary === "string") {
      onlyProfile.mechanicalFinding.summary =
        onlyProfile.mechanicalFinding.summary.replace(
          "is rated Cleanest Profile",
          "is rated Only Profile Measured (nothing to compare against)"
        );
    }
  }
} else if (profileSpecificFilterAnalysis.length > 1) {
  // The same placing rule, from the other side: with several
  // profiles in the field, "Cleanest" is a title only ONE can hold —
  // the one with the least remaining filtered vibration, the same
  // measure the recommendation below crowns as its baseline. Every
  // other below-threshold profile is Clean: a band it earned on its
  // own reading, not a placing.
  const cleanProfiles = profileSpecificFilterAnalysis.filter(
    (profile) => profile.mechanicalFinding?.status === "Cleanest Profile"
  );

  if (cleanProfiles.length > 0) {
    // A placing is a claim the evidence must carry (#47's doctrine,
    // applied to this lab too): a profile whose confidence is Low —
    // or whose sample count is dwarfed 20:1 by the best-measured
    // bank — cannot hold the comparative title, however clean its
    // few samples looked. It reads "Clean — limited evidence", and
    // the title goes to the best-SUPPORTED clean profile. When every
    // clean profile is thin, nobody is crowned.
    const largestSampleCount = profileSpecificFilterAnalysis.reduce(
      (max, profile) =>
        Math.max(max, profile.mechanicalFinding?.sampleCount ?? 0),
      0
    );
    const carriesEvidence = (profile) =>
      profile.mechanicalFinding?.confidence !== "Low" &&
      (profile.mechanicalFinding?.sampleCount ?? 0) * 20 >=
        largestSampleCount;

    const eligible = cleanProfiles.filter(carriesEvidence);
    const winner =
      eligible.length > 0
        ? eligible.reduce((best, current) =>
            (current.mechanicalFinding.averageFiltered ?? Infinity) <
            (best.mechanicalFinding.averageFiltered ?? Infinity)
              ? current
              : best
          )
        : null;

    for (const profile of cleanProfiles) {
      if (profile === winner) continue;
      const thin = !carriesEvidence(profile);
      profile.mechanicalFinding.status = thin
        ? "Clean — limited evidence"
        : "Clean";
      if (typeof profile.mechanicalFinding.summary === "string") {
        profile.mechanicalFinding.summary = thin
          ? profile.mechanicalFinding.summary.replace(
              /is rated Cleanest Profile with \w+ confidence from [\d,]+ samples/,
              `reads clean, but only ${profile.mechanicalFinding.sampleCount} samples were measured at this headspeed — too few to compare against the better-measured banks. Collect more flight time there`
            )
          : profile.mechanicalFinding.summary.replace(
              "is rated Cleanest Profile",
              "is rated Clean"
            );
      }
    }
  }
}
  


const aircraftFrequencyMaps =
  headspeedProfiles.length > 0
    ? headspeedProfiles.map((profile) => ({
        targetRpm: profile.targetRpm,
        averageRpm: profile.averageRpm,
        minimumRpm: profile.minimumRpm,
        maximumRpm: profile.maximumRpm,
        sampleCount: profile.sampleCount,
        frequencies: buildAircraftFrequencyMap(
          analysisContext,
          profile.averageRpm
        )
      }))
    : aircraftFrequencyMap
      ? [
          {
            targetRpm: null,
            averageRpm:
              aircraftFrequencyMap.averageHeadspeed,
            minimumRpm: null,
            maximumRpm: null,
            sampleCount: null,
            frequencies: aircraftFrequencyMap
          }
        ]
      : [];
;
const rawGyroValues = rawGyroColumns
  .slice(0, 3)
  .map((columnName) => ({
    columnName,
    values: extractNumericColumnValues(
      lines,
      telemetryHeaderIndex,
      columnName
    )
  }));

const filteredGyroValues = filteredGyroColumns
  .slice(0, 3)
  .map((columnName) => ({
    columnName,
    values: extractNumericColumnValues(
      lines,
      telemetryHeaderIndex,
      columnName
    )
    }));
    
  
const axisNames = ["Roll", "Pitch", "Yaw"];

const gyroReductionByAxis = rawGyroValues.map(
  (rawAxis, index) => {
    const filteredAxis = filteredGyroValues[index];

    const rawAverage =
      calculateAverageAbsolute(rawAxis.values);

    const filteredAverage =
      calculateAverageAbsolute(
        filteredAxis?.values || []
      );

    const reductionPercent =
      Number.isFinite(rawAverage) &&
      rawAverage > 0 &&
      Number.isFinite(filteredAverage)
        ? ((rawAverage - filteredAverage) /
            rawAverage) *
          100
        : null;

    return {
      axis: axisNames[index] || `Axis ${index}`,
      rawColumn: rawAxis.columnName,
      filteredColumn:
        filteredAxis?.columnName || null,
      rawAverage,
      filteredAverage,
      reductionPercent
    };
  }
);
const fftWindowSize = 4096;

const longestStableSegment =
  stableFlightPhase.segments
    .filter(
      (segment) =>
        Number.isInteger(segment.startIndex) &&
        segment.sampleCount >= fftWindowSize
    )
    .sort(
      (first, second) =>
        second.sampleCount - first.sampleCount
    )[0] || null;

const buildStableFftWindow = (columnName) => {
  if (longestStableSegment) {
    const centeredOffset =
      longestStableSegment.startIndex +
      Math.floor(
        (
          longestStableSegment.sampleCount -
          fftWindowSize
        ) / 2
      );

    return extractContiguousNumericWindow(
      lines,
      telemetryHeaderIndex,
      columnName,
      fftWindowSize,
      centeredOffset
    );
  }

  return [];
};
const rawFrequencyWindows =
  rawGyroColumns.slice(0, 3).map(
    (columnName) => ({
      columnName,
      values: buildStableFftWindow(columnName)
    })
  );

const filteredFrequencyWindows =
  filteredGyroColumns.slice(0, 3).map(
    (columnName) => ({
      columnName,
      values: buildStableFftWindow(columnName)
    })
  );
  
const frequencyPeaksByAxis = axisNames.map(
  (axisName, index) => {
    const rawSpectrum =
      calculateMagnitudeSpectrum(
        rawFrequencyWindows[index]?.values || [],
        sampleRate?.sampleRateHz
      );

    const filteredSpectrum =
      calculateMagnitudeSpectrum(
        filteredFrequencyWindows[index]?.values || [],
        sampleRate?.sampleRateHz
      );

    const rawPeak =
      findStrongestFrequency(
        rawSpectrum,
        20
      );

    const filteredPeak =
      findStrongestFrequency(
        filteredSpectrum,
        20
      );

    return {
      axis: axisName,
      rawPeak,
      filteredPeak
    };
  }
);
const hasUsableSpectrumEvidence =
  frequencyPeaksByAxis.some(
    (entry) =>
      entry.rawPeak !== null &&
      entry.rawPeak !== undefined
  );
const aircraftFrequencyMatches =
  frequencyPeaksByAxis.map((axisResult) => ({
    axis: axisResult.axis,

    rawMatch:
      findClosestAircraftFrequencyMatch(
        axisResult.rawPeak?.frequencyHz,
        aircraftFrequencyMaps
      ),

    filteredMatch:
      findClosestAircraftFrequencyMatch(
        axisResult.filteredPeak?.frequencyHz,
        aircraftFrequencyMaps
      )
  }));

;

  const detectedGroupCount = Object.values(
    detectedGroups
  ).filter((columns) => columns.length > 0).length;

  const evidence = [
    {
      source: "Blackbox-Log",
      status: hasBlackboxLog
        ? "Available"
        : "Unavailable"
    },
    {
      source: "Spalten gesamt",
      value: allColumns.length
    },
    {
      source: "Rohe Gyro-Spalten",
      value: rawGyroColumns
    },
    {
      source: "Gefilterte Gyro-Spalten",
      value: filteredGyroColumns
    },
    {
      source: "Setpoint-Spalten",
      value: setpointColumns
    },
    {
      source: "PID-Spalten",
      value: pidColumns
    },
    {
  source: "Motorausgangs-Spalten",
  value: motorOutputColumns,
},
{
  source: "Treffer bei Fluggerät-Frequenzen",
  value: aircraftFrequencyMatches,
},
{
  source: "Profilspezifische Filter-Analyse",
  value: profileSpecificFilterAnalysis,
},
];

const summaryFindings = [];

for (const profile of profileSpecificFilterAnalysis) {
  if (profile.mechanicalFinding?.summary) {
    summaryFindings.push(
      profile.mechanicalFinding.summary
    );
  }
  if (profile.mechanicalFinding?.controlMotionAssessment) {
  summaryFindings.push(
    `${profile.targetRpm} U/min Steuerbewegungs-Check: ` +
    profile.mechanicalFinding.controlMotionAssessment
  );
}
}
  const findings = [
    `Die Filter-Analyse hat ${allColumns.length} Blackbox-Spalten untersucht.`,
    `${detectedGroupCount} von 5 benötigten Spaltengruppen der Filter-Analyse wurden erkannt.`
  ];
  
if (aircraftFrequencyMatches.length > 0) {
 findings.push(
    `Mechanische Frequenzvergleiche wurden über ${aircraftFrequencyMatches.length} Gyro-${ aircraftFrequencyMatches.length === 1 ? "Achse" : "Achsen" } mit einem durchgehenden stabilen Governor-Flug-FFT-Fenster abgeschlossen.`
 );
}
  if (rawGyroColumns.length > 0) {
    findings.push(
      `Rohe Gyro-Spalten erkannt: ${rawGyroColumns.join(", ")}.`
    );
  } else {
    findings.push(
      "Rohe Gyro-Spalten wurden nicht erkannt."
    );
  }

  if (filteredGyroColumns.length > 0) {
    findings.push(
      `Gefilterte Gyro-Spalten erkannt: ${filteredGyroColumns.join(", ")}.`
    );
  } else {
    findings.push(
      "Gefilterte Gyro-Spalten wurden nicht erkannt."
    );
  }

  if (setpointColumns.length > 0) {
    findings.push(
      `Setpoint-Spalten erkannt: ${setpointColumns.join(", ")}.`
    );
  } else {
    findings.push(
      "Setpoint-Spalten wurden nicht erkannt."
    );
  }

  if (pidColumns.length > 0) {
    findings.push(
      `PID-bezogene Spalten erkannt: ${pidColumns.join(", ")}.`
    );
  } else {
    findings.push(
      "PID-bezogene Spalten wurden nicht erkannt."
    );
  }

  if (motorOutputColumns.length > 0) {
    findings.push(
      `Motorausgangs-Spalten erkannt: ${motorOutputColumns.join(", ")}.`
    );
  } else {
    findings.push(
      "Motorausgangs-Spalten wurden nicht erkannt."
    );
  }
  let matchedMechanicalPeakCount = 0;
let unmatchedMechanicalPeakCount = 0;
let matchedFilteredPeakCount = 0;
let unmatchedFilteredPeakCount = 0;
let lowFrequencyStructuralPeakCount = 0;
  for (const axisMatch of aircraftFrequencyMatches) {

    const rawMatch = axisMatch.rawMatch;
    const filteredMatch = axisMatch.filteredMatch;

    if (rawMatch?.isWithinTolerance) {
      matchedMechanicalPeakCount += 1;
      findings.push(
        `${axisMatch.axis} Rohspitze bei ` +
        `${rawMatch.peakFrequencyHz.toFixed(2)} Hz passte zu ` +
        `${rawMatch.frequencyName} bei ` +
        `${rawMatch.targetRpm ?? Math.round(rawMatch.averageRpm)} U/min ` +
        `innerhalb von ${rawMatch.differenceHz.toFixed(2)} Hz.`
      );
    } else if (rawMatch && rawMatch.peakFrequencyHz < 20) {
      // Below ~20 Hz the flight controller itself must respond, so
      // filters may not act there. Whatever this peak is, it is a
      // structural story — not an unexplained one, and not one the
      // filter settings can answer for.
      lowFrequencyStructuralPeakCount += 1;
      findings.push(
        `${axisMatch.axis} Rohspitze bei ` +
        `${rawMatch.peakFrequencyHz.toFixed(2)} Hz liegt unterhalb des ` +
        `Filterbands (~20 Hz): eine Struktur- oder Rahmenresonanz. ` +
        `Gyro-Filter dürfen hier nicht wirken, deshalb ist diese Spitze ein ` +
        `Werkbank-Thema, kein Filter-Einstellungs-Thema.`
      );
    } else if (rawMatch) {
      unmatchedMechanicalPeakCount += 1;
      findings.push(
        `${axisMatch.axis} Rohspitze bei ` +
        `${rawMatch.peakFrequencyHz.toFixed(2)} Hz passte zu keiner bekannten ` +
        `Fluggerät-Frequenz innerhalb der Toleranz. Am nächsten lag ` +
        `${rawMatch.frequencyName} bei ` +
        `${rawMatch.expectedFrequencyHz.toFixed(2)} Hz, ` +
        `${rawMatch.differenceHz.toFixed(2)} Hz entfernt.`
      );
    }
 if (filteredMatch?.isWithinTolerance) {
      matchedFilteredPeakCount += 1;

  
      findings.push(
        `${axisMatch.axis} gefilterte Spitze bei ` +
        `${filteredMatch.peakFrequencyHz.toFixed(2)} Hz passte zu ` +
        `${filteredMatch.frequencyName} bei ` +
        `${filteredMatch.targetRpm ?? Math.round(filteredMatch.averageRpm)} U/min ` +
        `innerhalb von ${filteredMatch.differenceHz.toFixed(2)} Hz.`
      );
    } else if (filteredMatch) {
  unmatchedFilteredPeakCount += 1;

  findings.push(
    `${axisMatch.axis} gefilterte Spitze bei ` +
    `${filteredMatch.peakFrequencyHz.toFixed(2)} Hz passte zu keiner bekannten ` +
    `Fluggerät-Frequenz innerhalb der Toleranz. Am nächsten lag ` +
    `${filteredMatch.frequencyName} bei ` +
    `${filteredMatch.expectedFrequencyHz.toFixed(2)} Hz, ` +
    `${filteredMatch.differenceHz.toFixed(2)} Hz entfernt.`
  );
}
}
if (aircraftFrequencyMatches.length > 0) {
  // The peak frequencies above are measured over this analysis's
  // own FFT window; the Noise Spectrum chart and the Home verdict
  // average across every stable run of the flight. On a peak that
  // drifts with rotor speed the two windows can legitimately read
  // a few Hz apart — say so, or the difference looks like an error.
  findings.push(
    "Die Spitzenfrequenzen in diesen Befunden stammen aus dem eigenen Messfenster der Filter-Analyse. Das Rauschspektrum-Diagramm und die Vibrationskarte auf dem Startbildschirm mitteln über jeden stabilen Abschnitt des Fluges, deshalb kann dieselbe Spitze dort einige Hz abweichend gelesen werden."
  );

  if (matchedMechanicalPeakCount === 0 && unmatchedMechanicalPeakCount > 0) {
  summaryFindings.push(
    "Die erkannten Vibrationsspitzen passen derzeit nicht zu den bekannten Drehfrequenzen des Fluggeräts."
  );
  summaryFindings.push(
    "Eine nicht zugeordnete Vibrationsspitze bedeutet nicht automatisch einen mechanischen Defekt; sie bedeutet nur, dass die stärkste erkannte Spitze nicht genau zu den bekannten Drehfrequenzen im Fluggeräte-Profil passte."
  );
const strongestAxes =
  profileSpecificFilterAnalysis
    .map((profile) => profile.mechanicalFinding?.strongestAxis)
    .filter(Boolean);

const yawIsStrongestAcrossProfiles =
  strongestAxes.length > 0 &&
  strongestAxes.every((axis) => axis === "Yaw");

if (yawIsStrongestAcrossProfiles) {
  summaryFindings.push(
    "Dass Gier die stärkste verbleibende gefilterte Achse ist, bedeutet, dass die Heck-Steuerrichtung die genaueste Prüfung verdient. Das beweist kein Heck-Problem, macht aber Heckmechanik, Heckblatt-Wuchtung, Heckantriebs-Frequenzen und Gier-Steueraktivität zu den nützlichsten Stellen für die nächste Untersuchung."
  );
}
}
  if (matchedMechanicalPeakCount > 0) {
  summaryFindings.push(
    `${matchedMechanicalPeakCount} erkannte Vibrations${ matchedMechanicalPeakCount === 1 ? "spitze passt" : "spitzen passen" } zu bekannten Drehfrequenzen des Fluggeräts.`
  );
}

summaryFindings.push(
  `Rohe mechanische Frequenzspitzen: ${matchedMechanicalPeakCount} passten zu bekannten Fluggerät-Frequenzen und ${unmatchedMechanicalPeakCount} lagen außerhalb der Toleranz.` 
);

summaryFindings.push(
  `Gefilterte Restspitzen: ${matchedFilteredPeakCount} stimmten mit bekannten Fluggerät-Frequenzen überein und ${unmatchedFilteredPeakCount} nicht. Nicht zugeordnete gefilterte Reste sind nicht automatisch Fehler; sie können schlicht die stärksten niedrigen Frequenzen sein, die übrig bleiben, nachdem die ursprünglichen mechanischen Spitzen unterdrückt wurden.`
);
}

findings.push(
  `Rohe mechanische Frequenz-Belege: ` +
  `${matchedMechanicalPeakCount} passten und ` +
  `${unmatchedMechanicalPeakCount} außerhalb der Toleranz.`
);

findings.push(
  `Gefilterte Rest-Frequenz-Belege: ` +
  `${matchedFilteredPeakCount} stimmten mit bekannten Fluggerät-Frequenzen überein und ` +
  `${unmatchedFilteredPeakCount} blieben nach der Filterung unzugeordnet.`
);
 evidence.push({
  source: "Zähler der mechanischen Frequenz-Treffer",
  value: {
  raw: {
    matched: matchedMechanicalPeakCount,
    outsideTolerance: unmatchedMechanicalPeakCount,
    totalCompared:
      matchedMechanicalPeakCount + unmatchedMechanicalPeakCount
  },
  filtered: {
    matched: matchedFilteredPeakCount,
    outsideTolerance: unmatchedFilteredPeakCount,
    totalCompared:
      matchedFilteredPeakCount + unmatchedFilteredPeakCount
  }
}
 });
 const hasStableProfileEvidence =
  profileSpecificFilterAnalysis.length > 0;

const hasSufficientFilterEvidence =
  hasUsableSpectrumEvidence ||
  hasStableProfileEvidence;
  const dataCompletenessScore = Math.round(
  (detectedGroupCount / 5) * 100
);

const profileResultPenalty =
  profileSpecificFilterAnalysis.reduce((totalPenalty, profile) => {
    const profileStatus = profile.mechanicalFinding?.status;

    if (profileStatus === "Needs Review") {
      return totalPenalty + 10;
    }

    if (profileStatus === "Monitor") {
      return totalPenalty + 5;
    }

    return totalPenalty;
  }, 0);

// ------------------------------------------------------
// What the analysis found, and what it could not settle.
//
// Detecting five column groups says the log is readable, not that
// the machine is well filtered. A score built from column presence
// alone reaches 100 while the same page reports an unexplained peak
// or filters that measurably remove almost nothing. These are the
// findings the score has to answer for.
// ------------------------------------------------------

// The quietest profile, and how much filtering actually achieved
// there. Needed by the score, and again by the recommendations below.
const quietestProfile =
  profileSpecificFilterAnalysis.length > 0
    ? profileSpecificFilterAnalysis.reduce((best, current) => {
        const bestFiltered =
          best.mechanicalFinding?.averageFiltered ?? Infinity;
        const currentFiltered =
          current.mechanicalFinding?.averageFiltered ?? Infinity;

        return currentFiltered < bestFiltered ? current : best;
      })
    : null;

const quietestReductions = quietestProfile
  ? [
      quietestProfile.roll?.reductionPercent,
      quietestProfile.pitch?.reductionPercent,
      quietestProfile.yaw?.reductionPercent
    ].filter(Number.isFinite)
  : [];

const averageReduction =
  quietestReductions.length > 0
    ? quietestReductions.reduce((total, value) => total + value, 0) /
      quietestReductions.length
    : null;

const remainingVibration =
  quietestProfile?.mechanicalFinding?.averageFiltered ?? null;

// The unavailability sentence is also a string — the flag must ask
// whether the assessment could actually RUN, or the penalty for
// missing evidence never fires and confidence reads High while the
// profile text says the evidence was unavailable.
const hasControlMotionEvidence =
  profileSpecificFilterAnalysis.some(
    (profile) =>
      profile.mechanicalFinding?.controlMotionAvailable === true
  );

const {
  findings: unresolvedFindings,
  penalty: unresolvedPenalty,
  vibrationStillMatters
} = assessUnresolvedFindings({
  unmatchedPeakCount: unmatchedMechanicalPeakCount,
  matchedPeakCount: matchedMechanicalPeakCount,
  averageReduction,
  remainingVibration,
  lowFrequencyPeakCount: lowFrequencyStructuralPeakCount
});

const score =
  hasSufficientFilterEvidence
    ? Math.max(
        0,
        Math.min(
          100,
          dataCompletenessScore -
            profileResultPenalty -
            unresolvedPenalty
        )
      )
    : null;
  let status = "Insufficient Data";
let severity = "warning";

if (!hasSufficientFilterEvidence) {
  status =
    "Filter Analysis Limited: Insufficient Evidence";
  severity = "warning";
} else if (detectedGroupCount === 5) {
  if (score >= 95) {
    status = "Filter Analysis Complete";
    severity = "info";
  } else if (score >= 80) {
    status =
      "Filter Analysis Complete: Monitor";
    severity = "warning";
  } else {
    status =
      "Filter Analysis Complete: Needs Review";
    severity = "warning";
  }
} else if (detectedGroupCount >= 3) {
  status = "Partial Column Detection";
  severity = "warning";
}
   
  

// Confidence is how much of the evidence this verdict rests on, so
// evidence the analysis never had has to lower it. Detecting every
// column group says the log was readable; it says nothing about
// whether the checks that need commanded motion or a stable profile
// could be run at all.
const missingEvidencePenalty =
  (hasControlMotionEvidence ? 0 : 25) +
  (hasStableProfileEvidence ? 0 : 15) +
  // Peaks the matcher could not explain are evidence the verdict
  // does NOT rest on — they lower confidence, never the score
  // (the fleet lesson: unmatched measures the matcher's reach).
  (unmatchedMechanicalPeakCount > matchedMechanicalPeakCount ? 15 : 0);

  const confidenceScore =
  hasSufficientFilterEvidence
    ? Math.max(
        0,
        (hasBlackboxLog
          ? Math.min(
              100,
              20 + detectedGroupCount * 16
            )
          : detectedGroupCount * 10) - missingEvidencePenalty
      )
    : 0;

let confidenceLabel =
  hasSufficientFilterEvidence
    ? "Low"
    : "Insufficient";

if (hasSufficientFilterEvidence) {
  if (confidenceScore >= 80) {
    confidenceLabel = "High";
  } else if (confidenceScore >= 45) {
    confidenceLabel = "Moderate";
  }
}

  const recommendations = [];

  if (detectedGroupCount < 5) {
    recommendations.push(
      "Prüfe die fehlenden Spaltengruppen, bevor Filter-Leistungs-Punktzahlen berechnet werden."
    );
  } else if (quietestProfile) {
let filterReductionAssessment = "";

// Little reduction means two opposite things depending on how much
// vibration there was to remove, and saying the wrong one sends a
// pilot chasing filters on a healthy machine.
if (Number.isFinite(averageReduction)) {
  if (averageReduction < LOW_REDUCTION_PERCENT) {
    filterReductionAssessment = vibrationStillMatters
      ? " Messbare Vibration blieb danach übrig, die Filter entfernen also nicht viel von dem, was da ist."
      : " Es gab wenig Vibration zu entfernen, deshalb ist es hier das erwartete Ergebnis, dass die Filter wenig tun.";
  } else if (averageReduction > 60) {
    // High reduction alone is the filters doing a big job, not proof
    // they are doing harm. The caution is only actionable when the
    // control-motion evidence shows tracking actually suffering;
    // without that, the number is informational and must not read as
    // a recommendation the verdict does not share.
    const controlSuffering = profileSpecificFilterAnalysis.some(
      (profile) =>
        profile.mechanicalFinding?.controlMotionConcern === "high" ||
        profile.mechanicalFinding?.controlMotionConcern === "moderate"
    );
    filterReductionAssessment = controlSuffering
      ? " Die hohe mittlere Reduktion verdient eine genauere Prüfung auf mögliches Über-Filtern: Die Belege zur Steuerbewegung zeigen, dass die Nachführung betroffen ist."
      : " Die hohe mittlere Reduktion spiegelt wider, wie viel Vibration die Filter entfernen mussten. Ohne Belege für Auswirkungen auf die Steuerbewegung ist das Information, kein Handlungsaufruf.";
  }
}

// With one profile there is nothing to be quietest against — say
// which profile was measured, not which one won.
const onlyOneProfile = profileSpecificFilterAnalysis.length === 1;

// "Use this as the baseline" turns an observation into a testing
// decision — a Low-confidence, short-window profile has not earned
// that promotion. It is still reported as the lowest OBSERVED, with
// the ask to collect more time at that headspeed first.
const quietestIsEstablished =
  quietestProfile.mechanicalFinding?.confidence === "High" ||
  quietestProfile.mechanicalFinding?.confidence === "Moderate";

recommendations.push(
  `${quietestProfile.targetRpm} U/min ${ onlyOneProfile ? "war das einzige analysierte Headspeed-Profil, daher lassen sich Profile nicht vergleichen" : quietestIsEstablished ? "hat derzeit die niedrigste verbleibende gefilterte Vibration" : `zeigte die niedrigste verbleibende gefilterte Vibration in den wenigen verfügbaren Samples (${quietestProfile.mechanicalFinding?.sampleCount ?? "wenige"} Samples)` }` +
  `${
    Number.isFinite(averageReduction)
      ? `: mittlere Gyro-Reduktion ${averageReduction.toFixed(1)} %`
      : ""
  }.` +
  filterReductionAssessment +
  (quietestIsEstablished
    ? ` Es sollte als Basis für den nächsten Vergleichsflug verwendet werden.`
    : ` Sammle mehr Zeit bei dieser Headspeed, bevor du sie als Vergleichsbasis verwendest.`)
);

for (const finding of unresolvedFindings) {
  recommendations.push(finding.reason);
}

if (!hasControlMotionEvidence) {
  recommendations.push(
    "Es waren keine Samples der kommandierten Bewegung verfügbar, deshalb konnte der Check, der Filterverzögerung von mechanischem Rauschen trennt, nicht laufen."
  );
}
} else {
  recommendations.push(
    "Rohe und gefilterte Gyro-Werte wurden erfolgreich verglichen, aber es waren keine stabilen Headspeed-Profile für eine profilspezifische Empfehlung verfügbar."
  );
}
  return {
    score,
    status,
    severity,
    confidence: {
      score: confidenceScore,
      label: confidenceLabel
    },
    summaryFindings,
    findings,
    recommendations,
    evidence,
    detectedColumns: detectedGroups,
    gyroReductionByAxis,
sampleRate,
frequencyPeaksByAxis,
aircraftFrequencyMaps,
aircraftFrequencyMatches,
profileSpecificFilterAnalysis,
};
}