# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

nomnom is a Vietnamese artisan bakery e-commerce website. The site is in Vietnamese (`lang="vi"`). It is in early development — only the core layout, hero section, and design system are complete.

## Commands

- `npm run dev` — start Vite dev server (default: http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — preview the production build

No test runner, linter, or formatter is configured.

## Tech Stack

- **Vite 6** with vanilla JS (ES modules, no framework)
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin — uses the new `@theme` directive in CSS (not `tailwind.config.js`)

## Architecture

Single-page static site. All source files are in `src/`:

- `index.html` — the full page markup (header, hero, footer); entry point loads `src/main.js`
- `src/style.css` — Tailwind import + design tokens via `@theme {}` + custom animations
- `src/main.js` — minimal JS (currently only sets the footer year)

## Design System (defined in `src/style.css` via `@theme`)

| Token | Value | Tailwind class |
|-------|-------|----------------|
| cream | `#FDFBF7` | `bg-cream`, `text-cream` |
| earth | `#D4C5B9` | `bg-earth`, `text-earth` |
| ink | `#0A0A0A` | `bg-ink`, `text-ink` |
| ash | `#6B6B6B` | `text-ash` |
| serif font | Playfair Display | `font-serif` |
| sans font | Inter | `font-sans` |

Custom CSS utilities: `.animate-fade-up`, `--radius-card`, `--ease-soft`.

## Roadmap

- Step 1: Core layout & design system (done)
- Step 2: Homepage & product grid
- Step 3: Cart drawer & checkout
- Step 4: "Our Story" section

## Conventions

- Fonts are loaded via Google Fonts in `index.html` `<head>`, not self-hosted
- Layout uses Tailwind utility classes inline; custom CSS is reserved for design tokens and animations only
- The project has no build-time type checking or linting — validate changes visually in the browser
