// ======================================================
// PACK SNIPPETS — the pack as paste-ready CLI text
// ======================================================
//
// Two snippets per pack: the forward snippet (apply the
// changes) and the revert snippet (the guaranteed undo,
// from the values the craft's dump held). Both carry their
// safety lines as comments — bench only, hover check first.
// A member without a numeric value appears as a commented
// instruction, never as a guessed number — and a snippet
// exists at all only when at least one member carries a real
// number to set. A pack of direction-only advice is applied by
// hand in the Configurator, not pasted: comments plus a bare
// `save` would write nothing and read like it did.
//
// ======================================================

export function packSnippet(pack, { packLabel = "Änderungspaket" } = {}) {
  if (!pack?.members?.length) {
    return null;
  }
  if (!pack.members.some((member) => Number.isFinite(member.to))) {
    return null;
  }

  const lines = [
    `# Blackbox Lab — ${packLabel}`,
    "# Nur auf der Werkbank einspielen, nie im armierten Zustand. Vorher einen Dump speichern.",
    "# Erster Flug danach: Hover-Check mit Abbruchkriterien vor jedem vollen Manöver."
  ];

  for (const member of pack.members) {
    if (Number.isFinite(member.to)) {
      lines.push(`set ${member.setting} = ${member.to}`);
    } else {
      lines.push(
        `# ${member.setting}: ein ${member.magnitudeClass} ${member.direction} (${member.numericNote})`
      );
    }
  }

  lines.push("save");
  return lines.join("\n");
}

export function revertSnippet(pack, { packLabel = "Änderungspaket" } = {}) {
  if (!pack?.members?.length) {
    return null;
  }

  const lines = [
    `# Blackbox Lab — ${packLabel} rückgängig machen (vorherige Werte wiederherstellen)`
  ];

  let restorable = 0;
  for (const member of pack.members) {
    if (Number.isFinite(member.from)) {
      lines.push(`set ${member.setting} = ${member.from}`);
      restorable += 1;
    } else {
      lines.push(
        `# ${member.setting}: vorheriger Wert nicht gespeichert — aus deinem gespeicherten Dump wiederherstellen`
      );
    }
  }

  if (restorable === 0) {
    return null;
  }

  lines.push("save");
  return { text: lines.join("\n"), restorable };
}
