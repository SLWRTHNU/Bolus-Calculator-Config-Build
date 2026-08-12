# Bolus Calculator

Mobile-first PWA insulin bolus calculator for Type 1 diabetes management.

**Live:** https://loop-bolus-calculator.pages.dev

---

## Features

- **Guest mode** — full calculator with Health Canada food database, no account required
- **Google Drive sync** — saves settings, personal food chart, and daily logs to your own Drive
- **CGM integration** — Nightscout and Dexcom Share for live BG/IOB/COB
- **Pre-bolus timing** — calculates when to dose before meals
- **Post-meal BG tracking** — log readings after dosing
- **Offline capable** — PWA with service worker caching
- **No backend** — static files only, OAuth PKCE flow

---

## Setup

### 1. Google Cloud Console

1. Go to https://console.cloud.google.com
2. Create project: `Bolus Calculator`
3. Enable **Google Sheets API** and **Google Drive API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized JavaScript origins: `https://loop-bolus-calculator.pages.dev` (and `http://localhost:PORT` for local dev)
7. Authorized redirect URIs: same URLs
8. Copy the **Client ID**

The Client ID is already set in `js/auth.js`:
```
79990057872-4vv92lo6gc27f8sfdteph2hhqb2k017o.apps.googleusercontent.com
```
Replace it if you fork this project and create your own OAuth credentials.

### 2. Icons

Open `icons/generate-icons.html` in a browser and download `icon-192.png` and `icon-512.png` into the `icons/` folder.

### 3. Deploy to Cloudflare Pages

1. Push this repo to GitHub
2. Log into [Cloudflare Pages](https://pages.cloudflare.com)
3. Connect your GitHub repo
4. Build command: *(leave blank — static site)*
5. Output directory: `/`
6. Deploy

The domain `loop-bolus-calculator.pages.dev` is already configured in the Cloudflare dashboard.

---

## Project Structure

```
loop-bolus-calculator/
├── index.html              # Single-page app shell
├── manifest.json           # PWA manifest
├── service-worker.js       # Cache-first shell, network-first APIs
├── icons/
│   ├── icon-192.png        # PWA icon (generate from generate-icons.html)
│   ├── icon-512.png
│   ├── icon.svg            # Source SVG
│   └── generate-icons.html # Canvas icon generator
├── css/
│   └── styles.css
├── js/
│   ├── app.js              # Main entry, state, routing
│   ├── auth.js             # Google OAuth 2.0 PKCE
│   ├── drive.js            # Drive API — folders, config.json
│   ├── sheets.js           # Sheets API — food chart, log export
│   ├── nightscout.js       # Nightscout REST API
│   ├── dexcom.js           # Dexcom Share API
│   ├── calculator.js       # Bolus math
│   ├── fooddata.js         # Health Canada built-in food database
│   ├── storage.js          # localStorage helpers
│   └── ui.js               # DOM helpers, theme, toasts
└── data/
    └── health_canada_review.xlsx   # Foods excluded from app (see below)
```

---

## Bolus Formula

```
net_carbs_i     = weight_g × carb_factor
total_carbs     = Σ net_carbs_i
meal_bolus      = total_carbs / ICR
correction      = (current_BG − target_BG) / ISF
total_bolus     = max(0, round(meal_bolus + correction − IOB, 2))
```

COB is displayed for reference only — not used in calculation.

---

## Google Drive Structure

On first connect, the app auto-creates:

```
Bolus Calculator/
├── config.json
├── Food Chart          (Google Sheet)
└── Food Log Exports/
    └── [YYYY]/
        └── [Month]/
            └── [Month DD - YYYY]   (Google Sheet)
```

`config.json` syncs all settings across devices. The same Google account = same data everywhere.

---

## localStorage Keys

| Key | Value |
|-----|-------|
| `lbc_google_token` | `{ access_token, refresh_token, expiry }` |
| `lbc_google_email` | Connected account email |
| `lbc_drive_folder_id` | Drive root folder ID |
| `lbc_food_sheet_id` | Food Chart sheet ID |
| `lbc_log_folder_id` | Log exports folder ID |
| `lbc_last_export_date` | `YYYY-MM-DD` |
| `lbc_today_log` | Array of session log entries |
| `lbc_units` | `mmol` or `mgdl` |
| `lbc_theme` | `light`, `dark`, or `system` |
| `lbc_meal_[slug]_icr` | ICR for meal (guest mode) |
| `lbc_meal_[slug]_isf` | ISF for meal (guest mode) |
| `lbc_meal_[slug]_target_bg` | Target BG for meal (guest mode) |

---

## Food Data

Built-in database from Health Canada's *Nutrient Value of Some Common Foods* (2008).

**Carb factor** = `carbohydrate_g / weight_g` — foods included only when both values are explicitly stated in grams.

Foods excluded due to volumetric-only measures, trace carb values, or ambiguous data are logged in `data/health_canada_review.xlsx`.

Default absorption rate for all Health Canada entries: **3.0 hours** (placeholder — override in your personal Food Chart sheet).

---

## Tech Stack

- Vanilla HTML/CSS/JS — no build step, no framework
- ES modules (`type="module"`)
- Google OAuth 2.0 PKCE (no backend, no client secret)
- Google Sheets API v4 + Drive API v3
- Nightscout REST API
- Dexcom Share API
- Cloudflare Pages (static hosting)

---

## Disclaimer

This tool is for informational purposes only. Always consult a qualified healthcare professional before making any insulin dosing decisions. Carb factors are approximate. The developers accept no liability for decisions made based on this calculator.
