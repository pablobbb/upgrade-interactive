---
name: generate-screenshot
description: Regenerate assets/screenshot.png, the terminal-window image at the top of the README. Invoke when the TUI's appearance changes — icons, colours, column widths, section layout, prompt text — or when the screenshot no longer matches what the tool renders. Also covers changing which packages the demo screen shows.
---

# Regenerate the README screenshot

`assets/screenshot.png` is the first thing anyone sees. It is **not** a terminal
capture — it is built from the real components, so it cannot drift from what the
tool renders, and it comes out byte-stable regardless of the machine, terminal or
installed fonts.

## Run it

```sh
node .claude/skills/generate-screenshot/make-screenshot.mjs
```

That overwrites `assets/screenshot.png` in place. Then **look at the result**
before committing — read the PNG back and compare it against what you changed.

Options:

| flag | effect |
| --- | --- |
| `--check` | print the rendered text frame and the dimensions, write nothing |
| `--out PATH` | write the PNG somewhere else |
| `--svg PATH` | also keep the intermediate SVG |

Use `--check` first when you've edited the fixture — it shows the layout as text,
which is far quicker to iterate on than looking at images.

## How it works

1. `fixture.mjs` composes the demo screen from the real `Prompt`, `Header`, `Row`,
   `VulnRow`, `OverrideRow` and `SectionHeader` components. Version-diff colours
   come from `colorizeVersionDiff`, so green/yellow/red segments are whatever the
   tool would actually produce.
2. It renders through `ink-testing-library` with `FORCE_COLOR=1` (the script sets
   this itself), giving a frame with 16-colour ANSI in it.
3. `make-screenshot.mjs` parses that ANSI into styled spans and emits an SVG
   "terminal window": Tokyo Night palette, **9px character cell, 20px line**,
   935px wide, macOS title bar. Inverted spans become a filled rect with the
   background colour punched out of it.
4. Chrome (headless, `--force-device-scale-factor=2`) rasterizes the SVG. The
   committed image is 1870×1144 — exactly 2× the 935×572 SVG.

Chrome is found automatically on macOS and common Linux paths; override with
`CHROME=/path/to/chrome`.

## Changing what it shows

Edit `fixture.mjs`. The dependency rows are plain tuples:

```js
// [name, current, range, latest, selectedColumn] — null column = not offered
['chalk', '^4.1.0', '^4.1.2', '^5.3.0', 0],
```

Keep the package set stable unless there's a reason to change it — swapping the
example packages every time makes the README look churny. `FOCUSED` picks the row
the cursor sits on.

The height follows the line count automatically, so adding rows is safe. The
width is fixed at 100 columns, which is what `ink-testing-library` reports and
what the layout is tuned for.

## Gotchas

- **Every glyph must be one column wide.** The SVG places text on a 9px grid, so
  a two-column glyph lands at the wrong x here exactly as it would in a real
  terminal. This is the same invariant `src/icons.js` documents and
  `test/unit/icons.test.mjs` enforces — if you added an icon, run the unit tests
  before regenerating.
- **The screenshot goes stale silently.** Nothing fails when the image no longer
  matches the code. It has drifted twice already. If a change alters the TUI's
  appearance, regenerate in the same commit.
- **Don't hand-edit the PNG or the SVG.** Change the fixture or the components
  and re-run; the whole point is that the image is derived.
- The image renders the tool's *current* icons and layout. If `README.md`
  describes an icon in prose (there's a `▲` on the vulnerability line), check
  the two agree.
