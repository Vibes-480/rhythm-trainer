# Rhythm Trainer

A free, offline rhythm sight-reading trainer that runs in the browser and installs on your phone like an app.
It's modelled on the features and layout of RhythmBot (including the Pro ones), for personal use.

## Features

**Metronome**: dial with number of beats and clicks per beat (turn the white disk to change tempo), tempo 20–300 BPM, tap tempo, 1–12 beats per bar with a quarter or eighth beat unit, 1–6 clicks per beat,
per-click accent / normal / soft / silent, mark beat one, 13 click sounds (click, woodblock, beep, rim click, cowbell, hi-hat, clave, sticks, mechanical tick, triangle, bell, shaker, electronic blip), practice timer, countdown timer,
gap click (play X bars, silent Y bars), stepwise trainer (increase, decrease or alternate every N bars or seconds),
and a setlist of saved setups.

**Rhythm screen**: summary bar (All / Bars / Complexity / BPM), one bar per row, Reading Mode and Play Along switches,
new-rhythm and play buttons, and a full settings list behind "All".

**Rhythm generator**: 1/2/4/8 bars, complexity 1–10, BPM, 11 time signatures (2/4 to 7/4, 5/8, 6/8, 7/8, 9/8, 12/8),
8th or 16th subdivision, triplets, ghost notes, accents, swing, space (rests), count-in, loop or once,
its own 16 sight-reading sounds (snare, five muffled snares tuned from piccolo down to deep, rimshot, brush snare, clap, cross-stick, conga, tom, marimba, bongo, cajon, bass drum; each plays once when you pick it), metronome click and click sound, built-in and saved presets. Tapping "New rhythm" while it plays swaps in the new rhythm at the next loop.

**Reading Mode**: endless sight-reading. Rows of new bars scroll in until you stop, or for a 1, 2 or 5 minute session.

**Play along**: tap the big pad (or any key on a computer) along with the rhythm. You get accuracy %, current and longest streak,
misses, extra taps, timing (early or late), coloured notes (green hit, amber off-time, red missed), most-missed groupings,
and a "Drill these" button that builds a new rhythm from the groupings you missed. Results are kept in History.

**Menu**: tap-latency calibration (do it once per phone or headphones), timing strictness, hear-the-rhythm toggle,
keep-screen-on while playing, light or dark theme, and export/import backups.

Everything is stored on the device (localStorage). There are no accounts and no tracking.

## Install on your phone

1. Open the site in Chrome on Android (or Safari on iPhone).
2. Chrome: tap **⋮ → Install app** (or **Add to Home screen**). Safari: tap **Share → Add to Home Screen**.
3. It now has its own icon, opens full screen and works offline.

Go to **Menu → Calibrate** once, so play-along scoring is fair on your phone.

## Hosting (GitHub Pages)

The app is plain static files with no build step.
In the repository go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then pick `main` and `/ (root)`.
The site appears at `https://<username>.github.io/<repo>/` within a minute or two.

After you push changes, bump `CACHE` in `sw.js` so installed copies pick up the new version.
Phones load the update on the next launch after that.

## Limits of a web app

- Audio stops if the phone locks or you switch apps for a long time. "Keep screen on while playing" (on by default) prevents the screen from locking while it plays.
- Tap timing depends on the phone and headphones. Calibration corrects for the average delay. Bluetooth headphones add the most delay, so calibrate again when you use them.

## Development

```
python3 scripts/build-single-file.py preview.html   # one-file build for previews (needs esbuild)
npm test                                    # unit tests: generator, notation durations, scoring
NODE_PATH=$(npm root -g) node tests/e2e.cjs  # end-to-end tests in headless Chromium (needs Playwright)
```

Notation is drawn with [VexFlow](https://www.vexflow.com) 4.2.5 (MIT), vendored in `js/vendor/`.
