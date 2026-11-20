'use strict';

// Reine Hilfsfunktionen fuer bootstrap-python.js (getrennt, damit sie testbar sind).

/** Aus pip-Specs nur exakte `name==version`-Pins ziehen; Namen klein, `_` -> `-`. */
function parsePins(specs) {
  const pins = {};
  for (const spec of specs) {
    const m = /^([A-Za-z0-9_.-]+)==([^\s;]+)$/.exec(spec);
    if (m) {
      pins[m[1].toLowerCase().replace(/_/g, '-')] = m[2];
    }
  }
  return pins;
}

/** true, wenn jedes gepinnte Paket in genau der gepinnten Version installiert ist. */
function envIsCurrent(installed, pins) {
  if (!installed) {
    return false;
  }
  return Object.entries(pins).every(([name, version]) => installed[name] === version);
}

module.exports = { parsePins, envIsCurrent };
