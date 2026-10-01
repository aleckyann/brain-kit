// Which known names a mistyped one probably meant, for the sentence that
// follows "unknown command" (the second stranger's F13): the names within
// two edits of it, or the one name it is the beginning of.
//
// Pure on purpose: it reads nothing, runs nothing and prints nothing. The
// caller hands it the names it really has (the command table the CLI runs,
// never a list copied beside it) and prints what comes back.

// The most edits (an inserted, a removed or a replaced letter) that still
// count as "close". Two is a slip of the fingers; three starts to suggest
// words nobody typed.
export const MAX_EDITS = 2;

// How many of them a word of this length may be off by. Two edits are the
// whole of a two-letter word, and half of the name of a four-letter command:
// "oo" is not a slip of "hook". So a word of one or two letters is judged by
// its beginning alone, one of three letters may be one edit away, and from
// four letters on it is MAX_EDITS.
export function allowedEdits(length) {
  if (length <= 2) return 0;
  return length === 3 ? 1 : MAX_EDITS;
}

// Levenshtein distance between two strings, over their UTF-16 code units
// (command names are ASCII), with two rows of the table kept.
export function editDistance(a, b) {
  const left = String(a);
  const right = String(b);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

// The names `typed` probably meant, in the order `names` lists them: the one
// name it is the beginning of when there is exactly one (a prefix is a
// sentence cut short, however many letters it lacks), else every name at the
// smallest distance when that is within allowedEdits, else none. Case is not
// a difference. Nothing is suggested for an empty word.
export function closestNames(typed, names) {
  const word = String(typed).toLowerCase();
  if (word === '') return [];
  const known = [...names].map((name) => [name, String(name).toLowerCase()]);
  const begun = known.filter(([, lower]) => lower.startsWith(word));
  if (begun.length === 1) return [begun[0][0]];
  const limit = allowedEdits(word.length);
  let best = limit + 1;
  let nearest = [];
  for (const [name, lower] of known) {
    const distance = editDistance(word, lower);
    if (distance < best) {
      best = distance;
      nearest = [name];
    } else if (distance === best && distance <= limit) {
      nearest.push(name);
    }
  }
  return nearest;
}
