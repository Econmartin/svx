# SVX Dashboard — Design Brief

> Generated using `taste-skill` `redesign-existing-projects` + `design-taste-frontend`
> audit protocols. Written by the agent for the agent, then executed against the
> current dashboard.

## 0. Design Read

**Reading this as:** an *operator-grade trading dashboard* for a *hackathon judge / LP / oncall ops*, in a *Hyperliquid × Bloomberg finance-terminal* language, leaning on **custom Tailwind on a near-black canvas with a single vibrant green primary**.

## 1. The Three Dials

| Dial | Setting | Why |
|---|---|---|
| **VARIANCE** | 3 / 10 | Restrained. This is an instrument, not Awwwards. Subtle asymmetry only. |
| **MOTION** | 2 / 10 | Sober. Hover lifts, value flashes on update, no scroll-driven shows. |
| **DENSITY** | 8 / 10 | High. Operators want signal-per-pixel. Reduce padding wherever it doesn't hurt. |

## 2. Anti-Default Discipline

The current dashboard is *good* but still carries three AI fingerprints flagged by the audit:

1. **`Inter` as body font** — the universal AI default. Sentence-level visual identity comes from the typeface as much as the palette. Swap to Geist Sans + Geist Mono.
2. **Three equal-width venue cards on About** — the most generic AI layout move. Should be broken (asymmetric grid or a single hero + two stacked).
3. **`lucide-react`** — also the AI default icon set. The taste-skill prescribes Phosphor or Tabler. Acceptable to defer this — biggest churn for incremental gain.
4. **Pure `#ef4444` for loss** — generic web red. Soften to `#ff5a5f` so it doesn't fight the green at small sizes.
5. **`text-xs uppercase tracking-wider` on every card title** — characteristic shadcn-default styling. Sentence case + medium weight reads more deliberate.
6. **Chart grid lines at full opacity** — `#1a2520` is correct hue but pull opacity down to ~50% so data lines dominate.
7. **Generic empty states** ("No settled trades yet — chart populates after the first settlement.") — replace with operator-specific copy that names the actual cause.

## 3. Audit Findings (high → low impact)

| # | Issue | Severity | Fix |
|---|---|---|---|
| 1 | Inter body font | High | Geist Sans body + Geist Mono numerics |
| 2 | Card title styling generic | High | Drop uppercase, sentence case + medium weight |
| 3 | Loss red too saturated | Med | `#ef4444` → `#ff5a5f` |
| 4 | Chart grid lines too prominent | Med | Pull stroke opacity to ~0.5 of current |
| 5 | Empty state copy generic | Med | Specific operator copy per chart |
| 6 | Card padding feels webby | Med | Reduce py-4 → py-3, keep px-4 |
| 7 | Three equal venue cards (About) | Med | Break to asymmetric 1-large + 2-small |
| 8 | Lucide icons throughout | Low | Defer — Phosphor swap is bigger than it sounds |
| 9 | "CUMULATIVE REALIZED PNL" header | Low | Sentence case + monospace |

## 4. Fix Priority (skill order)

1. Font swap — biggest visual delta, lowest risk
2. Palette refinement — loss color softening
3. Hover/active polish — card lift, number flash on update *(defer if tight on time)*
4. Layout — section labels, card padding, About page asymmetry
5. Empty states — write specific copy
6. Chart polish — gridline opacity, smaller axis labels

## 5. Out of Scope

- No framework swap (stick with Tailwind + shadcn)
- No new deps beyond Geist fonts (one Google Fonts import)
- All existing functionality preserved
- Lucide → Phosphor swap deferred as a follow-up

## 6. Definition of Done

- Body type is Geist (visible difference on every page)
- Loss color softer at small sizes
- Charts: grid lines recede, axis labels smaller
- Card padding tighter (more density)
- Section labels: sentence case, no uppercase tracking on the small ones
- Empty states say something useful
- Build passes typecheck + production build
- Bundle delta < 10KB
