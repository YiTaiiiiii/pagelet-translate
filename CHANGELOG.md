# Changelog

## Unreleased

- Optional floating ball on HTTPS pages: half tucked behind a side edge, slides out on hover, click to translate the page or restore it (white with a blue glyph, blue with a white glyph while translated); drag it anywhere and it rests on the nearer side. Off by default; turning it on in the options page asks for access to HTTPS sites.
- Fix: on the GitHub dashboard, the object of a feed heading ("a repository") was translated twice; translations no longer show long gaps from source indentation.
- Fix: pages left open while the extension is reloaded no longer log errors.

## 0.1.2 - 2026-11-08

- X long-form articles are translated: the title and body paragraphs, not just regular posts.

## 0.1.1 - 2026-11-07

- Translation now starts from the top of the screen. Hidden screen-reader text placed far off the page (such as Wikipedia's "Jump up to:" in references) made distant paragraphs look visible, so they were sent first and the visible ones started in the middle.

## 0.1.0 - 2026-11-07

First public release.

- Whole-page reading translation: bilingual or translation-only, keeps your reading position, translates ahead as you scroll, skips text already in the target language, per-paragraph original / retranslate, in-place retry, "always translate this site", Alt+T.
- API format: OpenAI-compatible (Chat Completions) or Anthropic-compatible (Messages).
- Model ID is configurable.
- Thinking strength: default, off, low, medium, high.
- Built-in provider presets, or a custom base URL.
- After an extension update, translating an already translated page asks for a refresh instead of adding a second translation.
- New icon.