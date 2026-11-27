# FPL Planner

A phone app (installable PWA) that suggests your Fantasy Premier League team every gameweek: transfers, starting XI, captain, and when to play each chip.

- **App:** https://grgsuman23.github.io/fpl-planner/ (open on your phone → browser menu → *Add to Home Screen*)
- **Data refresh:** full update every 4 hours; a team-news watcher checks FPL injury/suspension flags every 30 minutes and reruns the model as soon as anything changes. Run on demand: Actions → *Update FPL data* → *Run workflow*.

## Add your team

1. Find your team ID: on the FPL site open **Points**; it's the number after `/entry/` in the address.
2. Edit `config.json` and put it in `teamIds`, e.g. `"teamIds": [1234567]`. Commit; the update runs automatically.
3. In the app, tap the profile icon and enter the same ID.

Optional: `locks` sets per-team rules, e.g. `"locks": {"1234567": {"include": ["Isak", "Wirtz"], "exclude": ["Haaland"]}}`; the planner then builds transfers, Wildcard and Free Hit around them. Names are matched loosely (accents and case don't matter).

Optional: `freeTransfers` lets you override the calculated free-transfer count, e.g. `{"1234567": 2}`.

## How it works

`engine/` runs inside GitHub Actions (the FPL API blocks direct browser calls):

| File | Job |
|---|---|
| `fpl.mjs` | Fetches bootstrap, fixtures, last 4 GWs of live stats, and your team's picks, transfers, history |
| `model.mjs` | Expected points per player per fixture: appearance, xG/xA, clean sheets, goals conceded, saves, defensive contributions (DEFCON), bonus, cards. Adjusted for opponent attack/defence ratings, home advantage, minutes share, injury news, doubles and blanks |
| `optimize.mjs` | Integer-programming solver (GLPK): best legal 15 under budget, 2-5-5-3, max 3 per club, weekly XI and captain over a 6-GW horizon |
| `planner.mjs` | Selling prices, free transfers, transfer plans (0–N moves incl. hits), chip values per week (TC/BB/FH/WC) and a chip schedule respecting the GW19 first-set expiry |
| `run.mjs` | Writes `docs/data/latest.json` and `docs/data/team-<id>.json` |

`docs/` is the app (GitHub Pages).

Run locally: `npm ci && node engine/run.mjs` · offline test with synthetic data: `npm test`.

Projections are estimates. Check team news before the deadline.
