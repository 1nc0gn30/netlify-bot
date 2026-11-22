# Netlify marketing UI tokens (Nov 2026)

Captured from live pages with Playwright + Chromium at 1440×900 and 390px, then from computed CSS (`:root` custom properties and element `getComputedStyle`). Pages: `https://www.netlify.com/`, `/pricing/`, `/platform/agent-runners/`, and `https://app.netlify.com/login`. Screenshots live beside this file.

This is a visual-language reference for Cove. **Do not** hotlink Netlify or Peregrin webfonts, or use the Netlify logo / spark / wordmark as Cove branding.

## Canvas and surfaces

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#F7F6F4` | Page canvas (warm cream, not white, not dark) |
| `--color-bg-2` | `#F0EEEA` | Recessed / illustration wells |
| `--color-bg-3` / `--color-bg-muted` | `#E7E5E0` | Secondary buttons, chips, hairlines |
| `--color-bg-inverse` | `#131619` | Inverse blocks, code surfaces, dark footer bands |
| `--color-bg-panel-raised` / `--card-bg-color` | `#FFFFFF` | Raised cards, nav, chat cards |
| `--card-border-color` | `#E7E5E0` | Card / input borders |
| Quiet borders | `#DAD8D2`, `#F0EEEA` | Fainter rules |

Announcement bar (homepage): warm peach / coral wash, sampled about `#F9B180` → `#FDAA78`, dark ink text, full-width, compact (~36–40px). Cookie / legal cards sit as white rounded panels (~24–28px radius) with a cyan primary pill.

## Text

| Token | Value |
| --- | --- |
| `--color-text` | `#131619` (near-black ink) |
| `--color-text-weak` | `#56534C` |
| `--color-text-weaker` | `#736F67` |
| `--color-text-quiet` | `#B8B4AD` |
| `--color-text-inverse` | `#FFFFFF` |
| `--eyebrow-text-color` | `#56534C` |

## Brand / buttons

Primary accent is a bright cyan, **not** the older `#32E6E2`.

| Token | Value |
| --- | --- |
| `--color-brand-primary` / `--button-primary-bg-color` | `#01D4E5` |
| Primary hover | `#60DEEC` / `#2BD8E6` |
| Primary label | `#131619` |
| Outline / secondary stroke | `#131619` or `#E7E5E0` |
| Secondary fill | `#E7E5E0` |
| Teal scale (supporting, not CTA) | `#10DDC4` … `#00201B` |

Buttons are **pills** (`border-radius: 360px`).

- Primary (Sign up): ~15px / 500, padding `10px 17px`, `2px solid #01D4E5`, fill `#01D4E5`, ink label.
- Secondary / outline: padding ~`11px 18px`, `1px solid #131619` (or muted `#E7E5E0`), transparent or cream fill.
- Circular send (login / agent-runners chat mock): filled cyan circle, ink arrow, ~40–48px.

## Type

Netlify’s display face is **Systemia** (Peregrin Studio, licensed — do not embed or hotlink). Observed: display 80px / 600 / `-3.2px` (~`-0.04em`) tracking, line-height `1`, ink color, tight rag, often two short lines.

| Token | Value |
| --- | --- |
| Display 3xl / 4xl | `clamp(3rem, 2.1818rem + 3.6364vw, 5rem)` |
| Display 2xl / xl | clamp up to `3.75rem` (60px h2) |
| Display lg / md | clamp up to `2.625rem` (32px h3) |
| Text md / sm / xs | `1rem` / `0.875rem` / `0.75rem` |
| `--line-height-display` / heading | `1` |
| `--line-height-text` | `1.5` |
| `--ntl-tracking-tighter` | `-0.04em` |
| `--ntl-tracking-tight` | `-0.02em` |
| Nav links | 16px / 500, pill hover |
| Eyebrows / micro labels | **IBM Plex Mono** 12px / 600 / `0.2px` |

Cove licensed stand-in: **Inter Tight** (600 display, 500 UI; closer compact grotesk than IBM Plex Sans) + **IBM Plex Mono** from Google Fonts. Document Systemia as the source face; do not pretend Cove is set in it.

## Radius, shadow, spacing

| Token | Value |
| --- | --- |
| `--radius-pill` / `--ntl-radius-full` | `360px` |
| `--radius-2xl` | `1.875rem` (30px) |
| `--ntl-radius-panel` | `clamp(1.25rem, 0.9943rem + 1.1364vw, 1.875rem)` |
| `--ntl-radius-xl` | `1rem` |
| `--ntl-radius-l` | `0.75rem` |
| Card / product-UI radius | ~24–32px, often only the top corners of large well panels |
| Shadow | `0 12px 40px -12px #1316191f` |
| Footer pad | `96px 0 0` |
| Hero / section gutter | generous; two-column product pages ~56–80px |

## Layout patterns to match

1. **Announcement bar** → **light nav** (logo left, text links, outline + cyan pills right) → **huge tight headline** + short lede on the left, **rounded grain / gradient panel** on the right.
2. **Agent Runners / login chat**: left typography, right peach-to-teal (or peach-violet-teal) soft grain panel with a **nested white chat card**, mono labels, cyan circular send.
3. **Product sections**: cream canvas, large white rounded panels, small inset UI cards with hairline `#E7E5E0` borders and cyan accents.
4. **Code**: inverse `#131619` surface, light type, IBM Plex Mono, large radius.
5. **Footer**: plenty of top padding, weak ink links, quiet rules, legal line in weaker text.
6. **"Ask Netlify"** on marketing is a cyan pill, bottom-right — Cove should not copy the name; a similar chat affordance is fine.

## Iconography and illustration

Clean line icons, no heavy skeuomorphism. Marketing illustrations are soft 3D / frosted planes in cyan, peach, violet, and magenta on cream — grain, gentle depth, not cartoon characters. App login uses a chat-mock inside a rounded peach-teal well.

## Cove constraints

- Keep a clear **fan-made, not affiliated** label (announcement bar is the natural place).
- Do not use the Netlify logo, spark, or wordmark as Cove’s mark.
- Primary CTA cyan `#01D4E5`, cream canvas `#F7F6F4`, ink `#131619`, pills, tight 600-weight display type, nested white chat card in a soft peach-teal panel.
