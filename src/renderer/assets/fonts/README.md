# Fonts

The panel asks for **IBM Plex Sans** and falls back to
`Segoe UI Variable Text` -> `Segoe UI` -> `system-ui`.

`styles/tokens.css` declares IBM Plex Sans with `local()` sources ONLY. There is
deliberately no `url()` and no remote source:

- the app makes **zero network requests** (`connect-src 'none'`), so a webfont
  URL would simply fail;
- declaring a bundled file that is not actually present produces a 404 on every
  launch, which is noise in a panel that must be silent.

## Bundling a local subset (optional)

Drop these files here:

    IBMPlexSans-Regular.woff2
    IBMPlexSans-Medium.woff2
    IBMPlexSans-SemiBold.woff2

then add a `url()` to each `src` in `styles/tokens.css`:

    src: local("IBM Plex Sans"), url("../assets/fonts/IBMPlexSans-Regular.woff2") format("woff2");

Subset to Latin + the Turkish set (`ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü`) and the figures.
IBM Plex Sans is SIL OFL 1.1; ship the licence alongside it.

## Why the fallback is acceptable

Every figure in the panel sets `font-variant-numeric: tabular-nums lining-nums`.
Segoe UI and Segoe UI Variable both implement `tnum`, so digits stay
column-aligned as values tick. The fallback loses IBM Plex's instrument
character, not the numeric behaviour the design depends on.
