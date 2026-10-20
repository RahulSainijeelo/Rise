# Rise — Bug-Fix Pass Report

**Branch:** `staged`  **Date:** 2026-10-10
**Scope:** widget logic, the `deck_layout` phantom-profile logout, reminders, and tab-switch lag — plus every adjacent bug the audit turned up.
**Footprint:** 24 files edited, 2 deleted (dead code), 2 new files. TypeScript compiles clean apart from two pre-existing `RiseLogoAnimation.tsx` errors that predate this work.

---

## 1. The four things you reported

### a. Launching from the widget logged you into a phantom `deck_layout` profile

This was the most serious bug and the root cause is now certain.

`StorageService.getProfiles()` scanned **every** `.json` file in the `Rise_Data/` directory and treated each as a user profile, excluding only `system_settings.json`. But `DeckService` writes `deck_layout.json` into that same directory, and `SettingsService` writes `system_settings.json`. When a scanned file had no `id`/`name` (which a deck layout — shaped `{ cards: [...] }` — does not), the old code ran a "legacy fallback" that **fabricated a profile out of the filename**: `id = "deck_layout", name = "deck_layout"`. That is exactly the phantom profile you saw. Worse, `loadUserData("deck_layout")` would read that file, parse it, and hand the `{cards:[]}` blob back **as if it were a profile**, so entering through the widget could displace your real logged-in profile with an empty one.

Fixed in `StorageService.ts`:

- `NON_PROFILE_FILES = ['system_settings.json', 'deck_layout.json']` are excluded from the profile scan.
- A new `isProfileShape()` guard requires a non-empty string `id` **and** `name` **and** the absence of a `cards` array, so a deck layout can never be mistaken for a profile.
- The filename-fabrication fallback is gone; non-profile files are logged and skipped, **never deleted**.
- `loadUserData()` returns `null` for a non-profile file instead of fabricating a profile from it.

Two launch-path bugs that compounded it were also fixed: auto-login was happening in **both** `App.tsx` and `SplashScreen`, with `App.tsx` logging in using a hardcoded `name: 'User'` (P-05); `SplashScreen` is now the sole owner and loads the profile's real name. And `WidgetActionHandler` now refuses to mutate or navigate before a profile is active (P-08).

### b. Widgets using invalid logic and hardcoded data

The widget layer had three classes of defect: hardcoded strings/keys in native code, slot decisions made by reading a raw field instead of the sanctioned resolver, and user actions that were silently dropped.

- **Task toggles from the home-screen widget were lost (K-01).** `RiseWidget.kt` flipped the task only inside its own `widgetData` prefs blob — which JS never reads back, and which the next render overwrites. The tap did nothing durable. It now enqueues a durable `OP_TASK_TOGGLE` pending-op (drained by JS into the real task store) and *then* does the optimistic in-prefs flip for under-the-finger feedback. A new `OP_TASK_TOGGLE` constant was added to **both** halves of the contract in lockstep.
- **Slot decided by raw `sensorType` (W-02 / H-02).** `HabitMetrics.habitControls` and `DeckHabitCard` decided "is this a sensor habit?" by reading `habit.sensorType` directly. A habit whose `sensorType` went missing but whose `templateId` survived would fall through to the wrong controls. Both now route through `habitSlot(habit)` (templateId first), the one sanctioned resolver.
- **Stale data after logout (W-03).** `clearWidgetData` cleared only the task list, leaving the previous user's step counts, habit list, heatmap history and timer face on the home screen. It now empties every payload and writes `_meta.loggedIn: false`. As defense-in-depth, the three habit-bearing widgets (`HabitLinkWidget`, `HabitControlWidget`, `HabitGridService`) now gate on `WidgetContract.isLoggedIn()` natively, so they render their empty face even if the JS clear is unavailable on a given build (K-03).
- **Hardcoded prefs keys** in `RiseWidget.kt` (`"RiseWidgetPrefs"`, `"widgetData"`) were replaced with the `WidgetContract` constants, and the dead `tracking` field was removed from `SensorSlotPayload` (W-04), which also brought the TS and Kotlin slot shapes back into agreement.
- **Duration habits shipped an empty unit (W-01)** so the widget showed a bare number; fixed in `WidgetService`.

### c. Reminders — "daily enabled task completion and many more"

The notification layer never actually repeated and wasn't wired to the data that changes it.

- Recurring reminders used a one-shot trigger, so a "daily" reminder fired **once** and never again (T-03). They now use `RepeatFrequency.DAILY` / `.WEEKLY`.
- Habit reminders weren't repeatable and weren't re-synced when the habit changed (T-05); custom time strings failed to parse because `dayjs`'s `customParseFormat` plugin was never registered (T-08).
- The store never re-armed or cancelled reminders when a task was toggled, edited, or emptied of reminder times (T-01 / T-02). `toggleTask`, `updateTask`, `addHabit` and `updateHabit` are now wired to schedule/cancel, and the scheduler cancels first so clearing all times genuinely clears the reminder.
- Rescheduling fired on *every* edit and popped a "✅ Reminders Set" toast each time (T-04); it now only reschedules on a reminder-relevant change.

### d. Lag when switching tabs with many habits

Habit data lived in a flat `habits: Habit[]` array, so touching one habit produced a new array and re-rendered **every** habit row on every screen that read it — the lag you felt grew with habit count.

The in-memory store is now **normalized** like a database, mirroring the existing `NormalizedTaskStore`:

- New `src/utils/NormalizedHabitStore.ts` holds habits as `habitsById: Record<string, Habit>` + `habitIds: string[]`.
- New `src/store/selectors.ts` exposes narrow, memoized hooks (`useHabitIds`, `useHabit(id)`, `useHabitsArray`, `useHabitCount`, `useOccupiedSensorSlots`) built on `useShallow`.
- Lists now subscribe to the **id order only**; each row is a memoized child that subscribes to its **own** habit via `useHabit(id)`. Updating one habit shallow-copies the map and rebuilds exactly that one habit object, so React re-renders exactly one row — not the list. Applied to `HabitsScreen` (per-row `HabitRow`) and the Deck (`React.memo`'d `DeckHabitCard`).

Crucially, **the on-disk profile JSON shape is unchanged** — still `{ id, name, tasks[], habits[], labels }`. Normalization happens only in memory on hydration; `StorageService` serializes back to a `habits[]` array via `getHabitsArray`. No migration, no data rewrite.

---

## 2. Complete fix inventory

### Profiles, storage & launch

| ID | File | Symptom → Fix |
|----|------|---------------|
| P-01 | StorageService.ts | `deck_layout.json` / `system_settings.json` scanned as profiles → excluded via `NON_PROFILE_FILES`. |
| P-02 | StorageService.ts | Non-profile files fabricated a phantom profile from the filename; `loadUserData` returned them as profiles → `isProfileShape()` guard; returns `null`. |
| P-03 | useAppStore.ts | Default profile not persisted on every login → persisted. |
| P-04 | useAppStore.ts | `createProfile` didn't log in / set default → now does. |
| P-05 | App.tsx | Duplicate auto-login with hardcoded `name:'User'` → SplashScreen is sole owner, real name. |
| P-07 | StorageService.ts | `importProfile` silently overwrote on id collision → non-destructive; mints a unique id. |
| P-08 | WidgetActionHandler.tsx | Mutated/navigated with no active profile → gated on `activeProfile`. |
| P-10 | useAppStore.ts | Logout left default profile + labels set → clears default, resets labels. |

### Data layer & lag

| ID | File | Change |
|----|------|--------|
| B1 | NormalizedHabitStore.ts *(new)* | DB-style `byId` / `allIds` habit store. |
| B2 | useAppStore.ts | Store holds `habitsById`/`habitIds`; every habit action is a single `set` preserving unchanged object identities. |
| B3 | selectors.ts *(new)* | Narrow memoized hooks over the normalized store. |
| B5 | WidgetService.ts | Heatmap sync throttled; O(1) membership; single `dayjs()` base. |
| F11 | HomeScreen.tsx | Reads `byDate` indexes. |
| F12 | HabitsScreen.tsx | Explore "ADDED" state via `useOccupiedSensorSlots` (no subscription to habit contents). |
| F13 | DashboardScreen.tsx + styles | Dead, orphaned (referenced the removed `habits` field) → deleted. |

### Widget bridge & native

| ID | File | Symptom → Fix |
|----|------|---------------|
| W-01 | WidgetService.ts | Duration habits shipped empty unit → unit supplied. |
| W-02 / H-01 | HabitMetrics.ts | `habitControls` read raw `sensorType==='noise'` → `habitSlot(habit)==='noise'`. |
| W-03 | WidgetService.ts | `clearWidgetData` left sensor/habits/history/timer stale → clears all payloads + `loggedIn:false`. |
| W-04 | WidgetContract.ts | Dead `tracking` slot field → removed (realigns TS↔Kotlin). |
| W-06 | WidgetActionHandler.tsx | Action resolved from `route.path` → `route.name`. |
| W-07 | WidgetLabelPickerScreen.tsx | Whole-store subscription → narrow `labels` selector. |
| K-01 | RiseWidget.kt, WidgetContract.{ts,kt}, WidgetOpsService.ts | Task toggle was prefs-only (lost) → durable `OP_TASK_TOGGLE` + optimistic flip; drained via `toggleTask`. |
| K-03 | HabitLinkWidget.kt, HabitControlWidget.kt, HabitGridService.kt | No logged-in gate → `isLoggedIn()` gate; empty face when logged out. |

### Tasks & reminders

| ID | File | Symptom → Fix |
|----|------|---------------|
| T-01 | useAppStore.ts | `toggleTask` didn't re-arm/cancel reminders → wired. |
| T-02 | useAppStore.ts | `updateTask` didn't clear reminders on emptied list → cancel-first wiring. |
| T-03 | NotificationService.ts | Recurring reminders fired once → `RepeatFrequency.DAILY/WEEKLY`. |
| T-04 | useAppStore.ts / NotificationService.ts | Rescheduled on every edit + toast spam → only on reminder-relevant change. |
| T-05 | NotificationService.ts, useAppStore.ts | Habit reminders not repeatable / not re-synced → repeat + re-sync on `updateHabit`. |
| T-07 | NotificationService.ts | No-date reminders not surfaced → surfaced. |
| T-08 | NotificationService.ts | Custom time strings unparsed → `dayjs.extend(customParseFormat)`. |

### Habits, sensors & screens

| ID | File | Symptom → Fix |
|----|------|---------------|
| H-02 | DeckHabitCard.tsx | Raw `sensorType` slot reads → `habitSlot` + `React.memo`. |
| H-03 | SensorService.ts, HabitDetailScreen.tsx | Sunset unlock-count vs minutes unit confusion → split + consumer label. |
| H-04 | ProfileScreen.tsx | Seeding could clobber real data → `__DEV__`-gated, empty-profile-only, additive append. |
| H-05 | SensorService.ts | GPS/movement note split (pairs with the K-02 note). |
| H-06 | useAppStore.ts | Streak recomputed inconsistently → single `recomputeStreaks` helper. |

---

## 3. Deliberately not changed (recorded, not silently "fixed")

- **K-02 — movement vs steps.** This hardware exposes only a step counter; there is no distinct movement/cadence signal. The movement slot is fed the same daily step total as the pedometer, so "Immediate Rise" (goal 60) completes on the same first ~60 steps that begin Step Legend. This is a **product/naming decision** (rename the template, or add a real movement metric), not a code bug — fabricating an unverifiable value would be worse. A note in `SensorForegroundService.kt` documents it; flagged here for your decision.
- **T-06 — a recurring task never shows "completed."** Product decision; behavior left as-is, noted.
- **P-09** (no `deleteProfile`), **H-08** (goal 0), **H-09** (legacy `tickTimer` — confirm dead before removing), **H-10** (HabitsScreen badge exception), **K-05** (RC gap), **K-06** (native anchor only) — backlog; low-risk, out of scope for this pass.

---

## 4. Verification performed

TypeScript is the only runnable check in this environment; the native half is hand-verified.

- `npx tsc --noEmit` — clean except the two pre-existing `RiseLogoAnimation.tsx` errors (lines 101, 125), which are unrelated to this work and were present before it.
- **Android resource sweep** — every `R.drawable` / `R.id` / `R.layout` / `@drawable` / `@id` reference resolves against the files on disk.
- **XML well-formedness** — every file under `layout/`, `drawable*/`, `xml/`, `values/` parses, as does `AndroidManifest.xml`.
- **Bare `<View>` check** — no non-`@RemoteView` elements in widget layouts (the only hits are explanatory comments).
- **Contract mirror** — `WidgetContract.ts` ↔ `WidgetContract.kt` verified in lockstep; the only contract change this pass (`OP_TASK_TOGGLE = "taskToggle"`) landed on both sides, and the `tracking`-field removal realigned the slot shapes.
- **Kotlin review** — all seven changed Kotlin files read and checked by hand.
- **Normalization safety** — the two surviving `.habits` reads (`SensorService`, `WidgetOpsService`) are intentional dual-shape shims that check `habitsById`/`habitIds` first and fall back to a flat `habits[]` only for a raw on-disk profile object; they are not orphaned reads.

---

## 5. Architecture notes for future work

- **`habitSlot(habit)` is the only sanctioned habit→slot resolver** (`src/services/WidgetContract.ts`): `TEMPLATE_SLOT[templateId]` first, then a `sensorType`-in-`SENSOR_SLOTS` fallback, else `null`. Never read `habit.sensorType` to decide behavior — that disagreement is the historical root of the City Glider "widget renders but measures nothing" bug.
- **On-disk profile JSON stays `{ id, name, tasks[], habits[], labels }`.** Normalization is a hydration-time, in-memory concern only.
- **Local dates only** — `dayjs().format('YYYY-MM-DD')`, never `toISOString()` (rolls the day at 05:30 at UTC+5:30).
- **The widget contract is hand-mirrored** across `WidgetContract.ts` and `WidgetContract.kt`; SharedPreferences is an untyped string bag, so any key/slot/op/action change needs the matching edit on the other side.
