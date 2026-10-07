// ======================================================
// DIAGNOSIS ACADEMY — practice flights with a known answer
// ======================================================
//
// Each entry loads a bundled synthetic flight with exactly
// ONE planted problem. The pilot explores the labs, forms a
// diagnosis, then reveals the answer — the reveal walks the
// same evidence chain the app itself used, teaching how the
// instruments think.
//
// Every academy flight is generated (tools/generateSampleLog
// .mjs) with the defect planted to known ground truth and
// verified against the engine: each trips its own instrument
// at the fleet bars and stays quiet on the others. No real
// pilot's log ships here without their explicit permission.
//
// ======================================================

export const ACADEMY_ENTRIES = [
  {
    id: "imbalance",
    file: "sample-academy-imbalance.bbl",
    title: "Der Heli, der sich selbst unscharf schüttelte",
    teaser: "Fühlt sich überall rau an, aber das Tuning sieht gut aus. Wo schaust du hin?",
    brief:
      "Diese Maschine fliegt ihre Manöver ordentlich — und trotzdem stimmt eindeutig etwas nicht. Erkunde das Vibrations- und das Signal-Labor und sieh dann nach, was die Tuning-Instrumente sagen. Wenn du glaubst, die Grundursache zu kennen, decke die Antwort auf.",
    reveal: {
      diagnosis: [
        "Das Gyro-Spektrum zeigt eine starke Spitze bei der Einmal-pro-Umdrehung-Frequenz des Hauptrotors (bei dieser Headspeed etwa 30 Hz) — die Signatur einer Rotor-Unwucht, nicht eines Tuning-Wertes.",
        "Die Filter entfernen das meiste davon, aber der Rest erreicht trotzdem den Regelkreis — und zeigt sich sogar als scheinbares Gier-Schwingen (Review). Das ist Vibration im Tuning-Kostüm.",
        "Deshalb hält die Empfehlungs-Engine Tuning-Ratschläge zurück, solange eine mechanische Ursache vermutet wird: Hier an den Gains zu drehen hieße, um eine verbogene Ursache herumzutunen."
      ],
      fix:
        "Erst die Mechanik: Blätter und Kopf wuchten, Lager und Blattgriffe prüfen, dann erneut fliegen. Beweis ist, dass die Spektrumspitze schrumpft — das kann kein PID-Wert leisten."
    }
  },
  {
    id: "underdamped-roll",
    file: "sample-academy-underdamped-roll.bbl",
    title: "Das Rollen, das immer zurückkam",
    teaser: "Knackige Eingaben, aber etwas schwingt zurück. Welche Achse, und warum?",
    brief:
      "Gehe durch die Antwort-Auswertung (Response Review) und die Ereignis-Belege je Achse. Eine Achse verhält sich anders als die anderen beiden. Wenn du die Achse und das Muster benennen kannst, decke die Antwort auf.",
    reveal: {
      diagnosis: [
        "Das Zurückschwingen auf Roll liegt weit über der Flotten-Messlatte: Nachdem jedes Roll-Kommando seinen Höhepunkt erreicht, schwingt die Antwort durch das Ziel zurück, statt sich darauf einzupendeln.",
        "Nick und Gier zeigen kein solches Muster — der Defekt ist achsenspezifisch, was auf die Dämpfung dieser Achse hinweist, nicht auf etwas Globales wie Vibration oder Filter.",
        "Das ist die Signatur einer unterdämpften Achse: zu wenig Dämpfungsautorität für die verlangte Antwortgeschwindigkeit."
      ],
      fix:
        "Mehr Roll-Dämpfung (die D-Familie dieser Achse) oder eine sanftere Roll-Antwort, dann mit denselben knackigen Roll-Eingaben bestätigen — der Zurückschwing-Median im nächsten Log ist das Instrument, das genau diese Änderung prüft."
    }
  },
  {
    id: "weak-ff",
    file: "sample-academy-weak-ff.bbl",
    title: "Der Heli, der sich auf I stützte",
    teaser: "Er kommt an — spät und auf dem falschen Weg. Welcher Anteil macht die Arbeit?",
    brief:
      "Die Nachführung sieht auf den ersten Blick akzeptabel aus. Öffne den Beleg zur Kommando-Bilanz und schau, WELCHER PID-Anteil die Kommandos trägt. Wenn du sagen kannst, wer die Last stemmt, decke die Antwort auf.",
    reveal: {
      diagnosis: [
        "In den Kommando-Fenstern dominiert der I-Anteil, während P plus Feedforward kaum beitragen — genau das markiert das Kommando-Bilanz-Instrument auf der Achse mit dem höchsten Fehler.",
        "Die Maschine folgt dem Stick trotzdem, aber indem sie den Fehler nachträglich aufintegriert, statt das Kommando vorab zu bekommen. Deshalb fühlt sie sich spät und leicht gummiartig an.",
        "Nichts ist gesättigt und nichts schwingt — bei schwachem Feedforward ist die Bilanz das Instrument, das das Problem sieht, während die anderen ruhig bleiben."
      ],
      fix:
        "Erhöhe das Feedforward, damit das Kommando den Rotor direkt erreicht. Das prüfende Instrument: Im nächsten Log sinkt der I-Anteil während der Kommandos und die Unterstützung steigt — dieselben Bilanz-Zahlen, die es markiert haben."
    }
  },
  {
    id: "governor-droop",
    file: "sample-academy-governor-droop.bbl",
    dumpFile: "sample-academy-governor-droop.dump.txt",
    title: "Die Headspeed, die nachgab",
    teaser: "Jeder Steigflug kostet Rotordrehzahl. Wie viel, und was zahlt es zurück?",
    brief:
      "Öffne das Governor-Labor und beobachte die Headspeed gegen ihr Ziel durch die Kollektiv-Steigflüge. Wenn du sagen kannst, was unter Last passiert — und ungefähr wie viel —, decke die Antwort auf. Dieser Flug kommt AUCH mit seinem gespeicherten CLI-Dump: Füge ihn über „CLI-Einstellungen hinzufügen“ ein, und die verdiente Empfehlung wird zu einem exakten Wert mit einem einfügefertigen CLI-Snippet.",
    reveal: {
      diagnosis: [
        "Die Headspeed sackt jedes Mal um mehrere Prozent ein, wenn Kollektiv-Last kommt, und erholt sich langsam — klassischer Governor-Droop.",
        "Der Droop zeigt sich nur unter Last: In den Schwebeflug-Abschnitten sieht das Halten perfekt aus. Einen Governor an seinem Schwebeflug zu beurteilen ist genau, wie sich dieses Problem versteckt.",
        "Die Zyklik-Instrumente bleiben ruhig: Das ist ein Befund im Governor-Bereich, und die Engine hält Governor-Änderungen in ihrer eigenen Spur, weil gehaltene Headspeed überhaupt erst die anderen Instrumente vergleichbar macht."
      ],
      fix:
        "Mehr Governor-Gain (oder Precomp für die Last, die er kommen sieht), dann dieselben Steigflüge noch einmal. Das prüfende Instrument ist der Flug-Droop in Prozent unter Last — nicht der Schwebeflug-Durchschnitt."
    }
  },
  {
    id: "dead-current",
    file: "sample-academy-dead-current.bbl",
    title: "Der Sensor, der nichts las",
    teaser: "Die Leistungssummen gehen nicht auf — genauer gesagt, es gibt sie nicht.",
    brief:
      "Öffne das Akku-Labor und such nach der Strom-Geschichte. Etwas, das jeder andere Labor-Bericht hat, fehlt hier. Wenn du weißt, was — und was die App dagegen tut —, decke die Antwort auf.",
    reveal: {
      diagnosis: [
        "Der Stromsensor meldet nichts Brauchbares, daher ist jede stromabhängige Schlussfolgerung — Strom, Innenwiderstand, Verbrauch — ehrlich als „braucht einen Stromsensor“ markiert, statt geschätzt zu werden.",
        "Ein Analysewerkzeug, das hier eine plausibel aussehende Stromkurve erfände, würde jede nachfolgende Zahl vergiften. Benannte Abwesenheit schafft Vertrauen.",
        "Spannungsseitige Schlussfolgerungen gelten weiter: Sie stammen von einem Sensor, der tatsächlich gemeldet hat."
      ],
      fix:
        "Prüfe Verkabelung und Skalierung des Stromsensors. Sobald echte Ampere ins Log fließen, füllen sich die fehlenden Abschnitte von selbst — am Rest des Fluges muss nichts geändert werden."
    }
  },
  {
    id: "stale-dump",
    file: "sample-academy-stale-dump.bbl",
    dumpFile: "sample-academy-stale-dump.dump.txt",
    freshDumpFile: "sample-academy-stale-dump.fresh.dump.txt",
    title: "Der Dump, der log",
    teaser: "Die gespeicherten Einstellungen und der Flug widersprechen sich. Wem glaubst du?",
    brief:
      "Dieser Flug kommt MIT seinem gespeicherten CLI-Dump — kopiere ihn von dieser Karte und füge ihn in die Modellkarte ein („CLI-Einstellungen hinzufügen“). Beobachte dann, was die App dazu sagt. Wenn du verstehst, wer einen Widerspruch gewinnt, decke die Antwort auf.",
    reveal: {
      diagnosis: [
        "Zwei Einstellungen im eingefügten Dump widersprechen dem, was dieses Log tatsächlich geflogen ist — der Dump wurde vor einer Werkbank-Session gespeichert und nie aktualisiert. Dumps veralten unbemerkt.",
        "Die App prüft jede zugeordnete Einstellung gegen die geflogenen Header des Logs selbst und markiert den Widerspruch, statt der Datei zu vertrauen.",
        "Bei jeder Einstellung, die das Log enthält, gewinnt der geflogene Header-Wert — ein veralteter Dump kann dich warnen, aber nie eine Empfehlung falsch beziffern."
      ],
      fix:
        "Speichere nach jeder Werkbank-Session einen frischen Dump und aktualisiere ihn in der Modellkarte, wenn die App danach fragt. Probiere es hier aus: Kopiere den AKTUELLEN Dump unten — den nach der Werkbank-Session gespeicherten — und füge ihn über „Gespeicherten Einstellungs-Dump aktualisieren“ ein. Die Warnung verschwindet, weil die Datei endlich zum Flug passt. Sobald die App deine Einstellungen live aus der Flugsteuerung liest, geschieht diese Prüfung von selbst, bevor etwas geschrieben wird."
    }
  }
];

export function academyEntryById(id) {
  return ACADEMY_ENTRIES.find((entry) => entry.id === id) ?? null;
}
