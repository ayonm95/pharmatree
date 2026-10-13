# UI Review Baseline Report

**Project:** PharmaTree Supply Chain Portal  
**Date:** 2026-10-13  
**Status:** Baseline (Pre-refactor)  
**Score:** Needs Significant Improvement / Fail  

---

## 1. Design Token Compliance
- **Status:** **Fail**
- **Issues:**
  - `globals.css`: Dark background `#071822` and radial gradient definitions that clash with page modules.
  - `page.module.css`: Multiple hardcoded color hex values and arbitrary alpha rgba values (`rgba(126, 163, 255, 0.28)`, `#edf5ff`, `#172a37`, `#74a9ff`, `#fb7185`).
  - `verify/page.tsx`: Entire interface defined using 200+ lines of inline style objects with hardcoded hex codes (`#0d9488`, `#cbd5e1`, `#f8fafc`, `#1e293b`).
  - Arbitrary pixel values across both CSS modules and inline styles for padding, margins, and dimensions.

## 2. Coherence & Consistency ("One Choice Per Axis")
- **Status:** **Fail**
- **Issues:**
  - **Mixed Radius Personalities:** Buttons `12px`, Panels `18px`, Sidebar links `16px`, Popups `14px`, Badges `50%`. (Violates 8px/12px/pill rule).
  - **Iconography System:** System emojis (`🏠`, `🧴`, `🛡️`, `🔁`, `📦`, `🔔`, `✚`, `🏭`, `🚚`, `🏥`) mixed with Unicode symbols (`↗`). Uncontrolled OS-dependent styling.
  - **Theme Inconsistency:** `verify/page.tsx` renders an enterprise teal SaaS theme, while `page.module.css` renders a pastel glassmorphic theme.

## 3. Visual Effects & AI-Slop Aesthetics
- **Status:** **Fail**
- **Issues:**
  - Heavy `backdrop-filter: blur(18px)` and `blur(22px)` on topbars, sidebars, buttons, and popups.
  - 4 layers of nested radial gradients in background.
  - Buttons and cards have `transform: translateY(-2px) scale(1.01)` on hover with multi-layer colored drop shadows.
  - Pseudo-element gradient sweeps (`::before`, `::after`) on topbar and buttons.

## 4. Mobile & Responsive Layout
- **Status:** **Needs Improvement**
- **Issues:**
  - Fixed-width sidebar (240px) and fixed grid layouts without tablet/mobile drawer implementation.
  - Potential touch target violations on desktop-first icon buttons.

## 5. Accessibility (a11y)
- **Status:** **Needs Improvement**
- **Issues:**
  - Missing visible `:focus-visible` teal rings for keyboard navigators.
  - System modals in `PharmaWalletView.tsx` lack focus traps and `aria-modal` attributes.
  - Icon-only notification buttons lack proper `aria-label` tags or role attributes.

---

## Baseline Lighthouse Scores
- **Desktop:** Accessibility 100, Best Practices 100, SEO 100
- **Mobile:** Accessibility 100, Best Practices 100, SEO 100
- **Screenshots:** 18 baseline captures saved across viewports 375px, 768px, and 1280px in `docs/ui-baseline/`.
