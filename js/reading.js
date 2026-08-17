/* Builds the short narrative that ties a three-card spread together.
 * Deliberately templated rather than clever: it should read as a prompt for the person
 * doing the reading, not as an oracle. */

const POSITIONS = [
  { key: 'past', label: 'Past', lead: 'Behind you' },
  { key: 'present', label: 'Present', lead: 'Right now' },
  { key: 'future', label: 'Future', lead: 'Ahead' },
];

const CONNECTORS = [
  ['what shaped this', 'sits under everything'],
  ['what you are standing in', 'is the live question'],
  ['where it points', 'is still being decided'],
];

/** Strip a trailing full stop so fragments can be joined mid-sentence. */
function clause(text) {
  return String(text || '').trim().replace(/\.$/, '');
}

/** Lowercase the first letter unless the phrase starts with a proper noun. */
function soften(text) {
  const s = clause(text);
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function buildNarrative(entries) {
  if (!entries.length) return '';

  const parts = entries.map((entry, index) => {
    const position = POSITIONS[index] || POSITIONS[POSITIONS.length - 1];
    const orientation = entry.reversed ? entry.card.reversed : entry.card.essence;
    return `${position.lead}, ${entry.card.name}${entry.reversed ? ' reversed' : ''} — ${soften(orientation)}.`;
  });

  if (entries.length === 3) {
    const [past, present, future] = entries;
    const tone = present.reversed ? present.card.shadow : present.card.light;
    parts.push(
      `Read together: ${clause(past.card.name)} ${CONNECTORS[0][1]}, ` +
      `${soften(tone)} is what you are working with, and ` +
      `${clause(future.card.name)} is the direction it wants to run.`
    );
  }
  return parts.join(' ');
}

window.Reading = { POSITIONS, buildNarrative };
