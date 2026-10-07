# Blackbox Lab – deutsche Übersetzung (Teil 1)

## Einbauen
1. Sichere im Projektordner die Originale von `index.html`, `renderer.js`, `academy.js`, `index.js`, `index.css`.
2. Kopiere die fünf Dateien aus diesem Ordner darüber (gleiche Dateinamen, gleiche Stelle).
3. App neu starten (z. B. `npm start`).
Zurück zum Original: Backup zurückkopieren.

## Was übersetzt ist
- index.html: alle sichtbaren Texte (Seitenleiste, Anleitung, Labore, Einstellungen, Dialoge, Hinweise)
- renderer.js: Meldungen, Diagrammbeschriftungen, Tabellenköpfe, Empfehlungstexte der Startseite, Berichts- und Vergleichstexte
- academy.js: alle sechs Übungsflüge (Titel, Aufgabe, Auflösung)
- index.js: Titel und Dateityp des Speichern-Dialogs
- index.css: ein sichtbarer Text („Geladenes Log“)

## Bewusst auf Englisch gelassen
- Technische Begriffe: Headspeed, Governor, Gyro, Setpoint, Droop, Feedforward, Dump, CLI, Precomp
- Namen im Rotorflight Configurator (z. B. „Save flight log to file“, „Erase flash“), damit du sie dort wiederfindest
- Interne Vergleichswerte, die das Programm im Code prüft („Not found“, „Unknown craft“, „Insufficient Data“, „Governor droop“, Status wie „Clear“/„Review“)
- Fehlerbericht-Text für die Entwickler (errorReport.js) und Code-Kommentare

## Noch NICHT übersetzt (Dateien nicht hochgeladen)
Die App besteht aus über 50 Modulen. Die Urteile, Befunde und Empfehlungen der Labore kommen aus diesen Modulen und bleiben deshalb vorerst englisch:
analysis/ (flightVerdict, recommendationEngine, filterAdvisor, governorLabAnalysis, escLabAnalysis, batteryLabAnalysis, signalLabAnalysis, becLabAnalysis, compareFlights, flightEvents, governorEvents, packBuilder, packSnippet, precompAnalysis, evidenceViews, …) und ui/ (reportBuilder, screenUpdater, …).
Auch der PDF-Bericht wird in ui/reportBuilder.js gebaut.

## Wie geprüft wurde
- index.html: Tags, Attribute, IDs unverändert (1834 Tags identisch)
- renderer.js: Syntaxbaum identisch zum Original (24.251 Knoten), alle 640 Vergleichs-/Schlüssel-Texte unverändert
- academy.js: Einträge, IDs, Dateinamen identisch
Nicht getestet: das Programm selbst (laufende Electron-App) und das Layout mit den längeren deutschen Wörtern.
