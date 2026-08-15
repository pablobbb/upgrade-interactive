// Every glyph the TUI draws, in one place.
//
// All of them are plain text symbols, exactly one column wide, and none is an
// emoji. That is a hard requirement, not a style preference.
//
// Ink positions characters in `output.js` by its own rule — `fullWidth ||
// value.length > 1`, where `fullWidth` is `isFullwidthCodePoint`, which knows
// East Asian width and nothing about emoji. A Basic-Multilingual-Plane emoji is
// a single UTF-16 unit and is not East-Asian-wide, so Ink advances one column
// for it. (Ink's *other* width path, `measure-text.js`, uses `string-width` and
// says two. The two disagree; the one that places the glyph wins.)
//
// Whether that one column is wrong depends on the terminal. Where the font
// substitutes emoji for U+26A0 ⚠, U+2714 ✔ and U+2139 ℹ they are drawn two
// columns wide, they bleed into the cell beside them, and the row looks
// stretched; where the terminal honours their default text presentation they are
// drawn narrow and nothing is amiss. That is why the fault reads as intermittent
// across machines — and why the fix is a glyph that is one column *everywhere*
// rather than one that happens to line up here.
//
// An emoji can be pinned to a predictable width with U+FE0F, but it is then a
// fixed-colour glyph that ignores the `color` prop and outweighs the text it
// annotates. Text symbols take the colour, so a warning is red or yellow with its
// severity. (Astral emoji — U+1Fxxx: 📦 🔴 💡 — are the mirror-image trap: bare,
// they are a surrogate pair and Ink advances the two columns they occupy; add
// U+FE0F and the selector is tokenized as a character of its own, so Ink advances
// three for a glyph drawn in two.)
//
// test/unit/icons.test.mjs holds everything exported here to one column, and to
// Ink and the terminal agreeing on that, so a new icon that would stretch a row
// fails the suite rather than the layout.

// --- Cursor and selection -------------------------------------------------

export const CURSOR = '❯'; // the focused row
export const MARKER_ON = '●'; // this column is the row's staged choice
export const MARKER_OFF = '○'; // this column is offered but not chosen

// --- Structure ------------------------------------------------------------

export const WORKSPACE_BAR = '▌'; // leads a per-workspace heading
export const CHILD = '›'; // ownership: `parent › package`
export const BECOMES = '→'; // transition: `current → fixed`
export const SEPARATOR = '·'; // joins clauses inside one line

// --- Direction ------------------------------------------------------------
//
// Named separately from BECOMES even where the glyph is identical: these stand
// for the arrow *keys* in hints and for scroll position, so they follow the
// keyboard, while BECOMES is a typographic choice. Changing one shouldn't
// silently change the other.

export const UP = '↑';
export const DOWN = '↓';
export const LEFT = '←';
export const RIGHT = '→';

// --- Status ---------------------------------------------------------------

export const WARN = '▲'; // vulnerability marker; takes the severity's colour
export const CHECK = '✓'; // staged action, e.g. a queued override removal
export const INFO = 'ⓘ'; // advisory note explaining why something is as it is
