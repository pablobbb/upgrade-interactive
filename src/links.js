// OSC 8 terminal hyperlinks, with a plain-text fallback.

const OSC = ']8;;';
const BEL = '';

/**
 * Render `text` as a clickable link to `url` using the OSC 8 escape sequence
 * when writing to a TTY that can render it. When it can't (piped output, dumb
 * terminal), fall back to `text (url)` so the URL stays visible and copyable.
 */
export function hyperlink(text, url) {
  if (!url) return text;
  if (process.stdout && process.stdout.isTTY) {
    return `${OSC}${url}${BEL}${text}${OSC}${BEL}`;
  }
  return `${text} (${url})`;
}
