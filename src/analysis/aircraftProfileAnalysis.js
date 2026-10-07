function analyzeAircraftProfile(profile) {
  if (!profile) {
    return {
      score: 40,
      status: "Unknown Aircraft",
      finding:
        "Es wurde kein passendes Fluggeräte-Profil gefunden. Es gelten allgemeine Analyseregeln."
    };
  }

  return {
    score: 100,
    status: "Profile Matched",
    finding:
      `${profile.displayName} wurde erkannt und seine fluggerätespezifischen Zielwerte wurden geladen.`
  };
}
export { analyzeAircraftProfile };