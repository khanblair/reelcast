# ReelCast — Launch Video Guide (`/brag` + Hyperframes)

How to turn a project into a short launch video with the `/brag` skill, from the DeepSeek Harness (`dsh`) or Claude Code. It is the exact run that produced `brag-output/brag.mp4` (ReelCast, "Ship while you sleep", 22 s, 9:16), written as steps with **gates**, the traps that cost time, and the fixes.

Last verified 2026-09-18 — macOS arm64 (Apple M3), Node 26.7, FFmpeg 9.0.1, bun 1.3.14, Hyperframes 0.8.47/0.8.48, brag 0.2.2, dsh 0.1.5-rc.2, model `deepseek-flash`.

**Two readers.** The operator (you): §1, §2, §7, §8. The agent: §2–§6, reporting evidence at every gate.
**Agent — read §2 and §3 in full before the first tool call. Open §4–§6 when a gate goes red.**

**Vocabulary.** *Gate* = a phase's exit check; it is **green** when every listed condition holds and **red** otherwise; a red gate stops the run. *Baseline* = the resting state a tween must have when the timeline is seeked to any time. *Beat grid* = the music's tempo grid that scene events snap to. *Contract* = `brag-plan.md`, which every later phase follows.

## In 60 seconds (operator)

1. One-time: §1 (tools, skills, brag, dsh model, permissions `workspace-write` + `ask`).
2. `cd <project> && dsh web` → choose the project folder → paste the §2 prompt.
3. Answer the four `ask_user_question` prompts (concept, format, voice, numbers).
4. Approve commands as they arrive. At every gate the agent posts its evidence; a red gate means it fixes and retries, using §4–§6.
5. Finish with the §8 checklist. The video is `brag-output/brag.mp4`.

## Contents

0. [Target result](#0-target-result-reference-run)
1. [One-time machine setup](#1-one-time-machine-setup)
2. [Kickoff prompt](#2-kickoff-prompt)
3. [The run — phases and gates](#3-the-run--phases-and-gates)
4. [Composition rules](#4-composition-rules)
5. [Files, images, docs — what makes what](#5-files-images-docs--what-makes-what)
6. [Pitfalls — symptom, cause, fix](#6-pitfalls--symptom-cause-fix)
7. [DeepSeek Harness operations](#7-deepseek-harness-operations)
8. [Definition of done](#8-definition-of-done)
- [Appendix A — reference run data](#appendix-a--reference-run-data)
- [Appendix B — reference run log](#appendix-b--reference-run-log-in-order)
- [Appendix C — scripts](#appendix-c--scripts)

---

## 0. Target result (reference run)

| Item | Value |
|---|---|
| Idea | "Ship while you sleep": drop footage in → AI writes metadata → Auto-Publish counts down → 3:00 AM notification → "You were asleep." |
| Format | 9:16, 1080×1920, 30 fps, 22.12 s, 664 frames, 5 scenes |
| Audio | music bed (114.84 BPM) + 40 SFX clips, no voice; final −16.1 LUFS, LRA 1.8 LU, peak −1.7 dBFS |
| Gates | `lint` 0 errors · `check` 0 layout findings, contrast AA 24/24 · render ≈ 22 s |
| Deliverables | `brag.mp4` (4.6 MB, poster baked as frame 0), `brag.jpg`, `share-copy.txt`, `brag-plan.md`, `composition-brief.md`, `composition/` |
| Reference implementation | `brag-output/composition/index.html` (self-contained: CSS, 5 scenes, timeline, audio tags). `brag-output/` is untracked in git — back it up before deleting anything |

Re-render the reference without any model: `cd brag-output/composition && bunx hyperframes@0.8.47 render --output ../brag.mp4`. That yields the raw −23 LUFS mix; the poster and loudness master are Phases 12–13 (Appendix C2 reproduces the delivered file byte for byte from that raw render and `brag.jpg`).

---

## 1. One-time machine setup

### 1.1 Requirements

Node ≥ 22 · FFmpeg + ffprobe on `PATH` · Python 3 (audio-data script, checks; `numpy` for the verification snippets) · Chrome headless shell (Hyperframes downloads it to `~/.cache/hyperframes/chrome`).

```bash
bunx hyperframes doctor      # expect: "All checks passed"
```

Only for `--voice` (the reference video used none): Kokoro `python3 -m pip install --break-system-packages --user kokoro-onnx soundfile`, and `brew install whisper-cpp`. Homebrew Python is PEP 668-locked, hence `--break-system-packages --user`.

**CLI runner.** Commands below use `bunx` (bun-only rule). The reference run used `npx --yes hyperframes`; `bunx hyperframes` was re-verified for `--version`, `doctor`, `render --help`, `init --help`. The scaffold's `package.json` scripts still call `npx` internally, so run the `bunx` commands directly. The first `bunx hyperframes` downloads the package and can exceed a 3-minute tool timeout — run it in the background once.

### 1.2 Hyperframes skills (the agent must have them)

brag tells the agent to read `hyperframes-core`, `-animation`, `-creative`, `-keyframes`, `-cli`.

```bash
bunx hyperframes skills     # installs into ~/.claude/skills and ~/.agents/skills, links into other agents' dirs
bunx hyperframes telemetry disable   # optional: anonymous telemetry is on by default (subcommands: enable, disable, status)
```

This is a global change (dozens of skill folders). dsh scans `~/.agents/skills`, so the same install serves both harnesses.

### 1.3 The brag skill

- **Claude Code:** `claude plugin marketplace add latent-spaces/brag` then `claude plugin install brag@brag -y`.
- **dsh (verified):** copy the folder into dsh's skill root:

```bash
rsync -a --exclude '.DS_Store' ~/.claude/plugins/cache/brag/brag/0.2.2/skills/brag/ ~/.agents/skills/brag/
```

288 files / 16 MB: `SKILL.md`, `references/` (step 1–4, audio, tones), `assets/` (music, SFX, cue files), `scripts/`. A copy does not self-update; re-run `rsync` after plugin upgrades. (The brag README also lists `npx skills add https://github.com/latent-spaces/brag --skill brag`; untested with dsh.)

### 1.4 dsh

```bash
bun add -g @deepseek-ai/dsh@latest          # 0.1.5-rc.2 verified; ≥0.1.5 is required for deepseek-flash
```

`~/.dsh/settings.yaml` → `agent-default-model:` `provider: deepseek-official`, `model: deepseek-flash`, `reasoningEffort: high`. The key lives in `~/.dsh/.credentials.yaml` (never print it). **Why `deepseek-flash`:** it is DeepSeek V4.1-Flash and takes images; `deepseek-v4-pro` is text-only, and the agent must look at snapshots (§3 Phase 9). Details in §7.

### 1.5 Permissions — set before the first run

dsh presets: `read-only` (ask), `workspace-write` (ask), `danger-full-access` (approval **never**). Use **`workspace-write` + `ask`** and approve commands as they arrive: `bunx`, `ffmpeg`, Chrome, and network (Google Fonts at compile time, GSAP from jsDelivr, the npm registry). With `danger-full-access` + `never` nothing pauses — the agent builds apps, boots emulators, commits and pushes on its own (§6 P-A1).

---

## 2. Kickoff prompt

Paste, fill the `<…>` parts:

```text
Use the brag skill to make a launch video for the project at <ABSOLUTE PROJECT PATH>.

Work order: follow /brag steps 1-4 and the runbook in docs/BRAG-VIDEO-GUIDE.md §3, gate by gate.
After each gate, post the gate evidence (commands + results) and continue only when the gate is green.

Questions: ask me with the ask_user_question tool — at most 4 per call, 2-4 options each, recommended
option first. One call covers concept/tone, format, voice, numbers. Wait for my answers.

Visual sources: (1) files in this repo, (2) files I place in <PROJECT>/brag-assets/. If the app has no
captured UI, recreate its screens in HTML/CSS/SVG from the source and its theme tokens, and say so in
the plan.

Write only inside <PROJECT>/brag-output/ (reading anything in the repo is fine). For commits, pushes,
dependency installs, app builds, emulators/simulators and README edits: propose the action and wait for
my "yes". A "recommended" answer to a brag question never authorizes any of them.

Use local assets only (no remote URLs) and bunx for CLIs.
Deliver: brag.mp4 (poster baked as frame 0), brag.jpg, share-copy.txt, brag-plan.md,
composition-brief.md, composition/.
```

**brag options** (append to `/brag`): `--tone <preset|freeform>` (`default`, `polished`, `yc-parody`, `chaotic`, `deadpan`, `cinematic`, `app-store`) · `--format landscape|vertical|square` (default landscape) · `--duration <s>` (auto 15–25) · `--no-music` · `--no-sfx` · `--title "<text>"` · `--voice` (Kokoro narration, opt-in).

---

## 3. The run — phases and gates

Every path below is relative to the project root. If `brag-output/` already exists, use `brag-output-YYYY-MM-DD-HHmmss/` for the whole run (brag rule).

### Phase 0 — Preflight
```bash
cd <project>
bunx hyperframes doctor
ls -d brag-output* 2>/dev/null
```
**Gate 0 green when:** doctor is all ✓ and the output directory name is stated.

### Phase 1 — Inspect the project (brag step 1)
Read in this order: `README`, the landing/marketing page, theme/styles (palette, fonts), routes and key components of the **user flow** (entry → key action → result), `public/` icons and logos, and product copy that lives in backend code (ReelCast's real notification, "🎬 Published: “…” is now live on YouTube!", came from `convex/scheduled/runPublish.ts`). Skip `dist/`, `.next/`, lockfiles, tests, `.git/`.

Answer the nine rubric questions in `references/step-1-inspect.md`: 1 what the app is · 2 most impressive claim · 3 visual hook · 4 which UI to show · 5 shortest satisfying video · 6 tone · 7 audio feel · 8 share caption · 9 user flow worth showing.

**Gate 1 green when:** all nine are answered, each pointing at a repo file; verbatim strings, hex tokens and fonts are listed; placeholder stats (ReelCast's "10K+ videos / 50+ channels" bar) are marked unusable.

### Phase 2 — Ask the human
Four decisions via `ask_user_question`: **concept** (the angle), **format** (vertical/landscape/square), **voice** (off by default), **numbers** (use stats or not). Reference answers: "Ship while you sleep", vertical 9:16, no voice, no numbers.
**Gate 2 green when:** the four answers sit at the top of the plan.

### Phase 3 — Plan → `brag-output/brag-plan.md` (the contract)
Sections, in this order: What is this app? · The angle · Hook (first 2–3 s) · Key moments · Outro/punchline · User flow · Tone · Format + duration · Visual identity · Share copy (draft) · Audio direction · **Storyboard** (per scene: window, on-screen, interaction, audio intent, audio-coupled idea, music, transition) · Music mood · Audio summary. Pattern: hook 2–3 s → reveal 2–4 s → 2–3 highlights 5–12 s → punchline/outro 2–4 s.
**Gate 3 green when:** scene durations sum to 15–25 s · the hook lands in the first 2–3 s · ≥1 scene shows real UI or copy · every on-screen string traces to a repo file · no invented numbers.

### Phase 4 — Brief → `brag-output/composition-brief.md`
Sections: Objective · Output (dir, file, format, duration) · Source material (files read, product name, strongest claim, key UI moment, **copy that must appear verbatim**) · Creative direction (tone, angle, hook, outro, things to avoid) · Visual identity (bg, text, accent, display/body fonts) · Storyboard summary · Audio (role, arc, music, treatment, cue guidance, audio-reactive treatment, audio-coupled moments, SFX guidance, exact clip list) · Hyperframes instructions · Requirements met.
**Gate 4 green when:** the file exists and holds the verbatim-copy list, hex tokens and the audio plan.

### Phase 5 — Scaffold and assets
```bash
mkdir -p brag-output
bunx hyperframes@0.8.47 init brag-output/composition --resolution portrait --non-interactive --skip-transcribe
# creates index.html, hyperframes.json, meta.json, package.json, AGENTS.md, CLAUDE.md
```
`--resolution`: `landscape` 1920×1080 · `portrait` 1080×1920 · `landscape-4k` · `portrait-4k` · `square`.

Copy every asset locally — the render must not depend on a CDN:
```bash
SK=~/.agents/skills/brag/assets ; C=brag-output/composition
mkdir -p $C/assets/music $C/assets/sfx/{impact,interface,casino,keyboard}
cp $SK/music/happy-beats-business-moves-vol-9-by-ende-dot-app.mp3 $C/assets/music/
for f in impact/impactSoft_medium_001 impact/impactSoft_medium_002 impact/impactBell_heavy_000 \
         impact/impactBell_heavy_003 interface/click_003 interface/click_005 interface/drop_001 \
         interface/drop_002 interface/drop_003 interface/bong_001 casino/card-slide-1; do
  cp "$SK/sfx/$f.ogg" "$C/assets/sfx/$f.ogg"; done
for n in 003 005 008 012 015 019 023 027 031; do cp "$SK/sfx/keyboard/keypress-$n.wav" $C/assets/sfx/keyboard/; done
cp public/icons/icon.svg $C/assets/icon.svg
curl -sSL https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js -o $C/assets/gsap.min.js
```
**Gate 5 green when:** `assets/` holds `gsap.min.js` (~73 KB), the icon, one music file and every SFX file the audio plan names.

### Phase 6 — Audio design
1. **Music.** Tracks and cue files: `assets/music/` and `assets/music/cues/*.music-cues.json`. Reference: `vol-9`, 114.84 BPM (beat ≈ 0.522 s), warm mid-energy.
2. **Cues.** Read the cue file. Lock scene changes to *strong cues* (reference: 3.70, 4.23, 8.44, 12.65). Put sequential events on consecutive beats (chips 5.28 / 5.80 / 6.34 / 6.86; queue rows 9.50 / 10.01 / 10.54).
3. **SFX.** Choose from `assets/sfx/` using the safe list in `assets/sfx/sfx-analysis.md` (low/medium high-frequency risk only). Moderate density; typing ticks on every third character.
4. **Audio-reactive data** (subtle glow, never on text):
```bash
python3 ~/.agents/skills/hyperframes-creative/scripts/extract-audio-data.py \
  brag-output/composition/assets/music/<track>.mp3 -o audio-full.json --fps 30 --bands 16
```
5. **Clip table:** id · file · start · duration · volume · track for every clip (reference: 40 clips, Appendix A2). Generate the tags with `gen_audio.py` (Appendix C1) so numbers stay consistent.

**Gate 6 green when:** every clip has time/duration/volume/track · ≥3 strong-cue locks · chips and rows sit on consecutive beats · the music level comes from a `data-automation` lane (§4.4).

### Phase 7 — Author `composition/index.html`
Follow §4. Method that worked: keep the page as a template plus a generator that injects the `AUDIO` array and the `<audio>` tags, then fix every lint/check finding in the template and regenerate (never hand-edit the generated file). One idea per scene; recreate real UI in HTML/CSS; colors and fonts as CSS variables from Phase 1.
**Gate 7 green when:** the §4.9 checklist passes by inspection.

### Phase 8 — Gate: lint
```bash
cd brag-output/composition
bunx hyperframes@0.8.47 lint
```
**Gate 8 green when:** 0 errors, and each remaining warning has a stated reason (reference: `composition_file_too_large`, 358 lines, accepted). Fix table: §6 P-C.

### Phase 9 — Gate: check and look
```bash
bunx hyperframes@0.8.47 check --samples 24 --at-transitions --snapshots --json > check.json
bunx hyperframes@0.8.47 snapshot --at 2.4,3.4,3.85,6.9,8.6,11.9,12.9,13.7,15.8,17.4,18.7,20.6
```
`check` runs lint, then audits runtime errors, layout, motion and WCAG contrast in one browser pass. Persistent findings gate the exit code; entrance/exit transients show as ℹ. Contrast failures are errors — apply the suggested color.
Then **open every PNG** in `snapshots/` (dsh: `read_image`; Claude Code: Read) and answer per frame: all text fully inside the frame? nothing overlapping unintentionally? no empty frame? does the hook frame read without sound?
**Gate 9 green when:** `check` reports 0 errors and 0 layout findings, contrast AA passes on all checked text, and the per-frame answers are all "yes". Optional human review: `bunx hyperframes preview`.

### Phase 10 — Render
```bash
bunx hyperframes@0.8.47 render --output ../brag.mp4      # default quality "looks" (CRF 16), ≈22 s here
ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames -of compact=p=0 ../brag.mp4
```
Render length = the root `data-duration`. Quality: `draft` (iteration) · `looks` (default) · `delivery` (high). `--strict` fails the render on lint errors.
**Gate 10 green when:** h264 1080×1920 30 fps, `nb_frames` = round(duration × 30), AAC 48 kHz stereo, duration ≈ root `data-duration`.

### Phase 11 — Audio QA on the render
Run the three checks of Appendix C3-a (from `brag-output/`): **click** (first 30 ms), **tail** (last 1.5 s decays), **loudness** (`ebur128`). Reference raw render: −23.3 LUFS, peak −2.7 dBFS.
**Gate 11 green when:** the first 30 ms stay below 0.05 peak (the first designed hit lands at 0.12 s), the tail decays smoothly, and loudness is measured and written down. A click or silence gap sends you back to §4.4 / §6 P-D.

### Phase 12 — Poster frame
Pick a **settled** beat: text fully in, nothing mid-transition, postable on its own (reference: 1.3 s — headline landed, file card at 0 %, REC dot lit, cursor not yet in). Extract, **look at it**, then bake it into frame 0 during Phase 13's single encode.
```bash
ffmpeg -ss 1.3 -i ../brag.mp4 -frames:v 1 -q:v 2 ../brag.jpg
```
Frame 0 matters because Slack, X and Discord thumbnail from it and ignore cover-art metadata.
**Gate 12 green when:** `brag.jpg` is a settled, readable frame extracted from the same render (same pixel size).

### Phase 13 — Master loudness and bake the poster (one encode)
Target −16 LUFS / −2 dBTP for social. Sequence: back up the raw render → measure (pass 1) → apply (pass 2) **to a WAV** → verify the WAV → mux WAV + poster overlay in one video encode. Commands: Appendix C2 (run from the project root; it `cd`s into `brag-output/`).
Trade-off: loudnorm's dynamic mode removes 2–6 dB from the loudest hits (hook slam, countdown zero, bells) to reach −16 LUFS; use a −18 LUFS target for a lighter touch.
**Gate 13 green when:** all of Appendix C3-b hold — sample count equals the raw render's, cross-correlation lag = 0 at ≥10 windows spread over the whole timeline, and audio packet timestamps are contiguous (only `1024` deltas).

### Phase 14 — Share copy → `share-copy.txt`
One to three sentences, postable as-is, specific to the project, tone-matched. Default tone: `Made [App]. It's [what it does]. [Best line from the product.]` Reference: *"Made ReelCast. It takes your raw footage, writes the title and tags with AI, and publishes to YouTube on your schedule. Even while you sleep."*
**Gate 14 green when:** the file exists with ≤3 sentences and no generic launch language.

### Phase 15 — Deliver
Report: video path · share-copy path · one sentence on the creative approach · caveats · an offer to re-roll a scene, the tone or the angle. Send the file to the human if they work from another device.
**Gate 15 green when:** §8 is fully ticked.

---

## 4. Composition rules

### 4.1 Anatomy
```html
<div id="root" data-composition-id="main" data-start="0" data-duration="22.12" data-width="1080" data-height="1920">
  <section id="s1" class="clip" data-start="0"    data-duration="4.05" data-track-index="1"> … </section>
  <section id="s2" class="clip" data-start="3.7"  data-duration="4.96" data-track-index="2"> … </section>
  <audio id="sfx-hook" data-start="0.12" data-duration="0.19" data-track-index="11" data-volume="0.70"
         src="assets/sfx/impact/impactSoft_medium_001.ogg"></audio>
</div>
<script src="assets/gsap.min.js"></script>          <!-- in <head>, local file -->
<script> var tl = gsap.timeline({ paused: true }); …; window.__timelines["main"] = tl; </script>
```
- Root `data-duration` **is the render length**. `window.__timelines` key = `data-composition-id`.
- A standalone `index.html` root sits directly in `<body>` (no `<template>`).
- Root is sized by `data-width`/`data-height`; write `width/height:100%` in CSS, never `1080px`.

### 4.2 Timeline
One paused GSAP timeline, built synchronously, registered once. Animate `x/y/scale/rotation/opacity/color` (and `scaleX` for bars). No `repeat:-1` (use a finite count), no `Math.random`, `Date.now`, `performance.now`, no network, no `display`/`visibility` tweens, and never tween a `.clip` element itself — animate an inner wrapper.

### 4.3 Baselines (seek safety)
The renderer seeks to arbitrary times. Any element touched by several `fromTo` calls needs a resting state: one `tl.set(sel, {…rest}, 0)` and `immediateRender:false` on every later `fromTo`:
```js
tl.set("#filecard", { scale: 0.7, opacity: 0, y: 0, rotation: 0 }, 0);
tl.fromTo("#filecard", { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: .4, ease: "back.out(1.8)", immediateRender: false }, 0.7);
tl.fromTo("#filecard", { y: 0, rotation: 0 }, { y: 410, rotation: -2, duration: .6, ease: "power2.inOut", immediateRender: false }, 2.05);
```
Full-frame sheets that appear later start hidden in markup: `<div id="s4sheet" style="opacity:0">`.

### 4.4 Audio
- Every `<audio>` has `id`, `data-start`, `data-duration`, `data-track-index`, `data-volume`, a local `src`. An id-less clip is silently dropped.
- Overlapping clips use different `data-track-index` values (music 10, SFX 11+, typing ticks rotate 20–23).
- **Music level = a `data-automation` volume lane with `data-volume="1"`**, never GSAP `volume` tweens (a tween is not applied on frame 0 and lets the source MP3's opening transient click through):
```html
<audio id="bgm" data-start="0" data-duration="22.12" data-track-index="10" data-volume="1"
  data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":0},{"t":0.15,"v":0.06},{"t":0.35,"v":0.2},{"t":0.6,"v":0.35},{"t":20.8,"v":0.35},{"t":21.2,"v":0.31},{"t":21.6,"v":0.19},{"t":21.9,"v":0.07},{"t":22.12,"v":0}]}]}'
  src="assets/music/happy-beats-business-moves-vol-9-by-ende-dot-app.mp3"></audio>
```
(Inside the attribute the double quotes are written `&quot;` when generated by script.)
- No `crossorigin` on media. Repeated `<img>` with one source triggers `duplicate_media_discovery_risk` — inline the SVG.
- **Sync rule:** an SFX `data-start` equals the start time of the tween it accompanies (click at 1.95 = the grab tween at 1.95).

### 4.5 Audio-reactive glow
Inline the bass array (mean of bands 0–2, 2 decimals, `TOTAL×30+1` frames) and drive a CSS variable per frame:
```js
tl.to({}, { duration: TOTAL, ease: "none", onUpdate: function () {
  var f = Math.max(0, Math.min(AUDIO.n - 1, Math.round(tl.time() * AUDIO.fps)));
  ROOT.style.setProperty("--bass", AUDIO.bass[f]); } }, 0);
/* CSS */ .glow { opacity: calc(.30 + var(--bass) * .26); transform: scale(calc(1 + var(--bass) * .08)); }
```
Deterministic (reads `tl.time()`), background only.

### 4.6 Layout audit attributes (`check`)
| Attribute | Use on | Effect |
|---|---|---|
| `data-layout-ignore` | decorative glows, flares | skip overflow checks |
| `data-layout-allow-overlap` | stacked headline lines / labels that overlap on purpose | allow text overlap |
| `data-layout-allow-occlusion` | the element that gets **covered** (the outgoing scene sheet) | allow being covered at a wipe |
| `data-layout-allow-overflow` | intentional overflow | allow |
`data-layout-allow-occlusion` on the *occluder* does nothing.

### 4.7 Typography and reading time
Inter 900 headlines, Inter 400/700 body, JetBrains Mono for timecodes/counters. The compiler bundles fonts and fetches them from Google Fonts at build time (first build needs network; then cached). Short label ≈ 0.8 s settled; a sentence ≈ 0.3 s per word; fast-in, then hold. Keep a full set of chips visible ≥1.5 s after the last appears.

### 4.8 Motion recipes
Typed text and counters use a proxy object whose `onUpdate` writes text:
```js
var tp = { n: 0 };
tl.fromTo(tp, { n: 0 }, { n: TITLE.length, duration: 1.45, ease: "none", immediateRender: false,
  onUpdate: function () { TT.textContent = TITLE.slice(0, Math.round(tp.n)); } }, 4.32);
var cp = { s: 21581 };   // countdown 05:59:41 → 0
tl.fromTo(cp, { s: 21581 }, { s: 0, duration: 3.6, ease: "power1.in", immediateRender: false,
  onUpdate: function () { CD.textContent = fmt(cp.s); } }, 9.05);
```
`power2.in` is cubic and looks frozen for the first second; use `power1.in` for a visible count. Scene wipes: sheet slides `y:1920→0` (up) or `x:1080→0` (from the right) with `power3.out` / `expo.out`; fade the outgoing sheet 0.3 s.

### 4.9 Authoring checklist
1 root attributes correct · 2 one timeline registered under the same id · 3 every multi-`fromTo` element has a baseline · 4 later full-frame sheets start `opacity:0` · 5 all media local, every `<audio>` has an id · 6 music via lane, `data-volume="1"` · 7 overlapping clips on different tracks · 8 no random/time/network · 9 every string from the repo (Phase 1) · 10 hook visible by 0.5 s.

---

## 5. Files, images, docs — what makes what

| File | Made by | How | Used for |
|---|---|---|---|
| `brag-plan.md` | agent | Phase 3 | contract for later phases |
| `composition-brief.md` | agent | Phase 4 | Hyperframes handoff |
| `composition/index.html` | agent | Phase 7 (template + generator) | the video source |
| `composition/assets/…` | agent | Phase 5 (`cp`, `curl`) | local media |
| `composition/snapshots/frame-NN-at-Xs.png`, `contact-sheet-N.jpg` | `hyperframes snapshot` / `check --snapshots` | Phase 9 | visual review |
| `brag.mp4` (raw) | `hyperframes render` | Phase 10 | source for mastering; keep a copy |
| `brag.jpg` | `ffmpeg -ss T -frames:v 1` | Phase 12 | poster, thumbnail upload, `<video poster>` |
| `brag.mp4` (final) | `ffmpeg` mux | Phase 13 | the deliverable |
| `share-copy.txt` | agent | Phase 14 | caption |

**Images.** The reference video used no raster images: the UI is HTML/CSS/SVG and the logo is `icon.svg`. If you supply screenshots, put them in `assets/`, reference them relatively (`<img src="assets/screens/quiz.png">`) inside a clip, and avoid the same source twice in the DOM.

**Real UI by project type** — pick one, and say which in the plan:
| Project | Best source of "the thing" |
|---|---|
| Web app | Recreate the screens in HTML/CSS from the component source and theme tokens (reference run), with real product copy |
| Native mobile app | Screenshots the human supplies in `brag-assets/`, or a recreation from the theme (Compose/SwiftUI tokens). An emulator run (below) is a separate, explicit decision |
| CLI / library | Recreate a terminal or code card in HTML with the real commands |

**Emulator capture (only when the human approves it).** Headless, no window, no audio: `emulator -avd <name> -no-window -no-boot-anim -no-snapshot-load -no-audio`; wait with `adb wait-for-device` and poll `adb shell getprop sys.boot_completed`; install with `adb install -r <apk>`; capture with `adb exec-out screencap -p > frame.png`; check a frame isn't black with `ffmpeg … signalstats`; stop with `adb emu kill`. Requires a built APK, which is itself a build the human must approve.

---

## 6. Pitfalls — symptom, cause, fix

### A. Agent behavior and permissions
| ID | Symptom | Cause | Fix |
|---|---|---|---|
| P-A1 | The agent builds the app, boots an emulator, commits and pushes | brag's "Show the thing" law + no screenshots in the repo + "use recommended for the rest" + approval `never` / `danger-full-access` | §2 guardrails; supply `brag-assets/`; `workspace-write` + `ask`; answer each question yourself; stop a leftover emulator with `adb emu kill` |
| P-A2 | Questions arrive as a text list | the agent skipped its question tool | tell it: use `ask_user_question` (Claude Code: `AskUserQuestion`), ≤4 per call, recommended first |
| P-A3 | A "recommended" pick did more than you meant | recommended options can include side effects (e.g. "commit and push the working tree") | read each option's description; keep the §2 line that recommended answers never authorize side effects |
| P-A4 | The session has a different cwd than the project | the harness opened another workspace | pick the project folder in the UI; confirm `pwd` in the first tool call |

### B. Tooling
| ID | Symptom | Fix |
|---|---|---|
| P-B1 | zsh: `no matches found: 0:a?` | quote it: `-map '0:a?'` |
| P-B2 | `timeout: command not found` (macOS) | use the harness tool timeout or `gtimeout` |
| P-B3 | `diff -r` reports "Directory loop detected" | it follows symlinks: `diff -rq --no-dereference a b` |
| P-B4 | Node `zlib.zstdDecompressSync` returns only the first record of a `.zstd` log | use the CLI: `zstd -dc file > out.jsonl` |
| P-B5 | `pip install` refused (externally-managed environment) | `python3 -m pip install --break-system-packages --user …` |
| P-B6 | The first `bunx hyperframes …` call ran past a 3-minute tool timeout here (package download plus `doctor`'s checks) | run it in the background once; later calls reuse the cache |
| P-B7 | First render offline: fonts missing | the compiler fetches Inter/JetBrains Mono from Google Fonts at build time; build once with network |
| P-B8 | `hyperframes feedback` posted content | it posts to a public channel — run it only with the human's consent |
| P-B9 | `hyperframes skills` changed many folders | expected (global install + links to other agents' dirs) |
| P-B10 | `composition/AGENTS.md` and `CLAUDE.md` appeared | scaffold files; harmless; leave them |

### C. Composition — lint and check findings
| Rule / finding | Meaning | Fix |
|---|---|---|
| `gsap_repeated_fromto_without_baseline` ⚠ | several `fromTo` on one target; the last-authored "from" becomes the pre-seek state | `immediateRender:false` on later `fromTo`s + `tl.set` baseline (§4.3). Reference: `#bgm`, `#filecard`, `#curwrap`, `#ripple`, `#pfill`, `#cd`, `#r1pub`, `#logo`, the z's, proxy objects |
| `gsap_fullscreen_overlay_starts_visible` ✗ | a full-frame sheet is visible before its first opacity tween → blank/white early frames | inline `style="opacity:0"` on `#s4sheet`, `#s5sheet` |
| `audio_volume_tween_overrides_gain` ⚠ | tween replaces `data-volume` | `data-volume="1"` + a `data-automation` lane (§4.4) |
| `duplicate_media_discovery_risk` ⚠ | two `<img>` with the same source | inline SVG for repeated icons |
| `composition_file_too_large` ⚠ | maintainability note | accept, or split scenes into sub-compositions |
| `content_overlap` (check) | stacked display lines | `data-layout-allow-overlap` on the lines, or give each its own zone |
| `container_overflow` on glows | decorative glow bigger than its sheet | `data-layout-ignore` |
| `text_occluded` at a wipe | the incoming sheet covers text of the outgoing one | `data-layout-allow-occlusion` on the **covered** sheet; shorten the outgoing clip's `data-duration` so the overlap is brief |
| label and countdown crowd each other | tight spacing | margins (`.cd{margin-top:30px}`, `.slots{margin-top:34px}`) |
| ℹ transient at t = entrance/exit | not gating | ignore unless it persists |
| A snapshot at t > duration | harmless; length is governed by root `data-duration` | ignore |

### D. Audio
| ID | Symptom | Cause | Fix |
|---|---|---|---|
| P-D1 | A click at the very start (peak −2.4 dBFS inside 30 ms) | the source MP3 opens with a loud transient; a GSAP fade-in tween is not applied on frame 0 | replace GSAP `volume` tweens with a lane whose first point is `v:0` at `t:0`; re-render; re-check the first 30 ms |
| P-D2 | Raw mix is quiet (−23.3 LUFS) | SFX peaks set the ceiling; music bed at 0.35 | master in Phase 13 |
| P-D3 | After `-af loudnorm` in an MP4 encode, audio after 19.2 s plays 80 ms late | loudnorm (dynamic mode) emits timestamps that leave a gap; one packet reported `duration 4864` instead of 1024. Decoded-PCM comparisons cannot see it because decoding drops timestamps | write the mastered audio to a **WAV**, mux the WAV; verify packet timestamps (Appendix C3-b) |
| P-D4 | `atrim=end=…` after loudnorm shortened the audio by 80 ms and cut the fade tail | trims the delayed stream | do not trim; use the WAV route |
| P-D5 | Alignment "verified" but wrong | cross-correlation ran only on the first 4 s | test ≥10 windows across the whole timeline **and** packet timestamps |
| P-D6 | Loudest hits feel softer after mastering | dynamic loudnorm attenuates 2–6 dB at the hits (payoff at 12.6 s got +1.6 dB vs +7.8 dB median) | accept, or target −18 LUFS |
| P-D7 | Container says audio 22.12 s, video 22.133 s | AAC framing | normal — the raw render shows the same |

### E. Delivery
| ID | Symptom | Fix |
|---|---|---|
| P-E1 | Poster shows a fade or half-typed text | pick a settled beat; nudge ±0.3 s and re-extract |
| P-E2 | Poster overlay misaligned | extract it from the same render (same pixel size) |
| P-E3 | Only the raw render exists | keep a copy of the raw render before Phase 13 |
| P-E4 | `git status` shows `brag-output/` | expected; add it to `.gitignore` only when the human asks |

### F. dsh
| ID | Symptom | Fix |
|---|---|---|
| P-F1 | `dsh` → `error: --profile <name> is required` | there is no default profile: `dsh web` or `dsh --profile headless "task"` (`bin.js:88`; the 0.1.2 launcher had the same check) |
| P-F2 | No terminal chat UI | shipped profiles are `acp`, `headless`, `sdk`, `sdk-minimal`, `web`; `tui` in `--help` is an example name |
| P-F3 | Web UI returns 401 | it needs the tokenized URL printed at start; the token is a secret |
| P-F4 | Old `dsh` still runs after an upgrade | `which -a dsh`; the old copy sat first on `PATH` |
| P-F5 | `disabled: true` on skill rows in `--dump-config` | host rows are disabled on purpose; the agent preset mounts skills (verified by loading `brag`) |
| P-F6 | `deepseek-flash` unknown | dsh < 0.1.5 |
| P-F7 | bun "blocked postinstalls" | reviewed: the DeepSeek one only chmods `spawn-helper` (already `+x` on arm64) |

---

## 7. DeepSeek Harness operations

**Start and use**
```bash
dsh web                     # opens http://127.0.0.1:3080/?token=…  (--no-open, --port <n>)
dsh --profile headless "task text"   # one-shot: prints the final answer, reasoning on stderr
```
In the web UI choose the project folder as the workspace, then type `/brag`. A `/name` in your message loads that skill; the `skill` tool returns "Base directory for this skill: `~/.agents/skills/brag`", so relative paths like `references/step-1-inspect.md` resolve. dsh also offers subagents, a todo list, `ask_user_question` and `read_image` (used to view frames).

**Model.** `~/.dsh/settings.yaml` → `agent-default-model.model`. `deepseek-flash` (V4.1-Flash, 1M context, image input, thinking) vs `deepseek-v4-pro` (text-only; described by the harness as stronger at agentic coding and hard reasoning, higher cost). Try Flash first for brag because it can review frames; switch to Pro if composition quality is the bottleneck and accept blind visual review. `reasoningEffort`: `off`, `low`, `high`, `max`.

**Permissions.** §1.5. The session log records changes ("approval policy changed from ask to never").

**Backups.** Before upgrades: `cp -Rp ~/.dsh ~/.dsh.bak-<date>` and verify with `diff -rq --no-dereference`. The 2026-09-18 upgrade backup lives in `~/.dsh.bak-20260918/` with `old-launcher/ROLLBACK.txt`. It holds a copy of the key file — keep it private.

**Reading a session log** (why did the agent do X?):
```bash
F=$(ls -t ~/.dsh/sessions/*/session-*/session.v3.jsonl.zstd | head -1)
zstd -dc "$F" > /tmp/session.jsonl          # Node's zstd reads only the first frame — use the CLI
python3 - <<'EOF'
import json
for l in open("/tmp/session.jsonl"):
    r = json.loads(l)
    if r["type"] == "tool/call":
        d = r["data"]; print(r["seq"], d["name"], d["arguments"][:160].replace("\n", " "))
EOF
```
Record types: `user/message`, `assistant/message` (includes reasoning), `tool/call`, `tool/result`, `subagent/catalog`, `todo/write`. Logs hold your prompts and tool output — private.

### 7.1 Case study — "why did it open an emulator?"
An Android (Kotlin) project. The agent inspected the repo, asked its questions, and the human said to use recommended options for the rest. brag's creative law says at least one scene must show real UI ("Show the thing"); the repo had no screenshots or recordings, and the recommended option was running-app footage. A subagent built the debug APK, then the agent launched an AVD as a windowed background job with no prompt (approval was `never`, file policy `danger-full-access`) and asked afterwards. Asked "why", it explained this chain and that it should have flagged a visible GUI side effect first. It then restarted the emulator headless (`-no-window`) and captured with `adb`. The same session also committed and pushed after the human picked "Commit and push the working tree before filming (Recommended)".
Lessons: (1) put visual sources in `brag-assets/` up front; (2) `workspace-write` + `ask`; (3) the §2 sentence that recommended answers never authorize side effects; (4) after any session, check for leftovers: `pgrep -fl 'qemu|emulator|hyperframes|dsh'`.

---

## 8. Definition of done

Run from `brag-output/`:
```bash
ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,profile,width,height,r_frame_rate,nb_frames,pix_fmt,sample_rate,channels -of compact=p=0 brag.mp4
ffmpeg -hide_banner -nostats -i brag.mp4 -af ebur128=peak=sample+true -f null - 2>&1 | tail -16 | grep -E "I:|LRA:|Peak:"
```
- [ ] `brag.mp4`, `brag.jpg`, `share-copy.txt`, `brag-plan.md`, `composition-brief.md`, `composition/` all exist
- [ ] `check` green (0 errors, 0 layout findings, contrast passes); every warning explained
- [ ] h264 High, yuv420p, 1080×1920 (for vertical), 30 fps; `nb_frames` = round(duration × 30); AAC LC 48 kHz stereo
- [ ] duration within 15–25 s and equal to root `data-duration` (±0.05 s)
- [ ] frame 0 equals `brag.jpg` (PSNR > 45 dB; reference 48.9)
- [ ] first 30 ms peak < 0.05; tail decays smoothly
- [ ] loudness −16 ±1 LUFS, peak ≤ −1.5 dBFS (reference −16.1 / −1.7)
- [ ] audio packets contiguous (`{1024: N-1}`); lag 0 at ≥10 windows
- [ ] every on-screen string traceable to the repo; no invented numbers
- [ ] `git status` in the project shows only `brag-output/` (plus changes the human approved)
- [ ] no leftover processes: `pgrep -fl 'qemu|emulator|hyperframes|dsh'`
- [ ] the raw render is kept; the final message lists caveats

---

## Appendix A — Reference run data

### A1 Scenes
| # | Scene | Clip window (s) | Locks | Content |
|---|---|---|---|---|
| 1 | Hook | 0 – 4.05 | hook slam 0.12 · grab 1.95 · drop 2.63 · done 3.30 | "You hit / record." (record in red), REC blink, viewfinder corners; file card `IMG_4471.mov · 812 MB · 0:47`; simulated cursor drags it into "Upload your footage"; progress 2.72–3.32; ✓ Uploaded |
| 2 | AI writes the metadata | 3.70 – 8.66 | Ready flip 4.23 · chips 5.28/5.80/6.34/6.86 · buttons 7.4 | Generating → Ready; title types 4.32–5.77: "10 YouTube Thumbnail Mistakes Killing Your CTR (Fix These Today)"; tags youtube thumbnails · increase CTR · thumbnail design · youtube growth |
| 3 | Even while you sleep | 8.44 – 14.37 | rows 9.50/10.01/10.54 · countdown 9.05→12.65 · published 13.18 | Auto-Publish card, slots 03:00·12:00·20:00, countdown 21581 s → 0, row 1 ready → publishing → published; "Set your cadence." → "Even while you sleep." at 10.54; moon + z z z |
| 4 | Proof | 14.22 – 18.46 | notification 14.76 · check 15.28 · caption 16.34/16.62 | lock screen "3:00", Sleep pill, real notification "🎬 Published: “10 YouTube Thumbnail Mistakes…” is now live on YouTube!", "You were asleep." |
| 5 | Outro | 18.24 – 22.12 | logo bell 18.44 | icon, "ReelCast", "From raw footage / to live on YouTube.", "Built for creators who ship daily." (sub at 20.3) |

Design tokens: `--bg #0f0f0f` `--card #1a1a1a` `--sec #272727` `--bd #333333` `--fg #f1f1f1` `--mut #aaaaaa` `--red #ff0335` `--green #2ba640` (pill text `#4ade80`) `--amber #f59e0b`. Fonts: Inter 900/700/400, JetBrains Mono.

### A2 Audio clips
| id | file (`assets/sfx/…`) | start | dur | vol | track |
|---|---|---|---|---|---|
| sfx-hook | impact/impactSoft_medium_001.ogg | 0.12 | 0.19 | 0.70 | 11 |
| sfx-card | interface/drop_002.ogg | 0.95 | 0.20 | 0.55 | 12 |
| sfx-grab | interface/click_003.ogg | 1.95 | 0.05 | 0.60 | 13 |
| sfx-drop | interface/drop_001.ogg | 2.63 | 0.12 | 0.60 | 14 |
| sfx-done | interface/click_005.ogg | 3.30 | 0.05 | 0.55 | 15 |
| sfx-ready | interface/bong_001.ogg | 4.23 | 0.13 | 0.60 | 16 |
| sfx-chip1–4 | interface/drop_002.ogg | 5.28 / 5.80 / 6.34 / 6.86 | 0.19 | 0.35 | 17 |
| sfx-s3 | casino/card-slide-1.ogg | 8.50 | 0.60 | 0.50 | 18 |
| sfx-row1–3 | interface/drop_003.ogg | 9.50 / 10.01 / 10.54 | 0.19 | 0.35 | 19 |
| sfx-zero | impact/impactSoft_medium_002.ogg | 12.62 | 0.14 | 0.80 | 24 |
| sfx-pub | interface/click_005.ogg | 13.18 | 0.05 | 0.55 | 25 |
| sfx-nslide | casino/card-slide-1.ogg | 14.68 | 0.60 | 0.50 | 26 |
| sfx-nbell | impact/impactBell_heavy_000.ogg | 14.86 | 1.48 | 0.55 | 27 |
| sfx-logo | impact/impactBell_heavy_003.ogg | 18.42 | 0.65 | 0.70 | 28 |
| tick-01…21 | keyboard/keypress-{003,012,019,027,005,023,008,031,015} cycling | every 3rd character, 4.32 → 5.77 | 0.13 | 0.30 | 20–23 rotating |

Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3`, lane in §4.4 (level 0.35).

### A3 Numbers worth remembering
Raw render −23.3 LUFS, sample peak 0.737 (−2.7 dBFS, the hook slam) → measured pass 1: I −23.24, TP −2.65, LRA 1.90, thresh −33.28, offset 0.42 → mastered −16.1 LUFS, LRA 1.8, peak −1.7 dBFS. Final file 4,610,385 bytes; raw 6.4 MB.

---

## Appendix B — Reference run log (in order)

1. Install brag: `claude plugin marketplace add latent-spaces/brag` → `claude plugin install brag@brag -y` → `claude plugin list`.
2. `hyperframes doctor`; installed Kokoro and MusicGen dependencies and `whisper-cpp` (voice stack; unused — no voice); local TTS smoke test.
3. New session; `/brag`; the human answered four questions (concept, format, voice, numbers).
4. `hyperframes skills` installed the Hyperframes skills.
5. Inspected ReelCast: `IDEA.md`, the marketing page, `globals.css`, `layout.tsx`, `convex/scheduled/runPublish.ts` (real notification copy), `public/icons/icon.svg`.
6. Wrote `brag-plan.md`, later `composition-brief.md`, then `share-copy.txt`.
7. `hyperframes init brag-output/composition --resolution portrait --non-interactive --skip-transcribe`.
8. Copied music, SFX, icon; downloaded GSAP 3.14.2; ran `extract-audio-data.py` (16 bands, 30 fps).
9. Wrote `template.html` + `build.py` (generator); generated `index.html` (665 audio frames, 40 clips, 21 typing ticks).
10. **Lint loop:** baselines for repeated `fromTo`s, inline SVG for the notification icon, `data-volume="1"`, inline `opacity:0` on later sheets.
11. **Check loop:** layout attributes (`allow-overlap`, `ignore`, `allow-occlusion` on covered sheets), spacing, shorter outgoing clips; countdown ease changed to `power1.in`.
12. Snapshots reviewed (12 frames + contact sheets); render (≈22 s).
13. Audio QA found the start click → replaced GSAP volume tweens with a `data-automation` lane → re-render; click gone.
14. Measured −23.3 LUFS; extracted poster candidates at 1.0/1.3/1.7/3.4/6.9/12.9/15.9/19.8 s; chose 1.3 s.
15. First master encoded loudnorm inside the MP4 → review flagged an audio-timing problem → found the 80 ms hole at 19.2 s → redid the master via WAV, verified sample count, lag 0 over 16 windows, contiguous packets → installed as `brag.mp4`.
16. Sent the file to the human; delivered the report and caveats.

---

## Appendix C — Scripts

### C1 `gen_audio.py` — audio tags and the bass array
```python
#!/usr/bin/env python3
"""Print the <audio> tags and the AUDIO bass array for index.html (run inside composition/)."""
import json
TOTAL, FPS = 22.12, 30
TITLE = "10 YouTube Thumbnail Mistakes Killing Your CTR (Fix These Today)"
MUSIC = "assets/music/happy-beats-business-moves-vol-9-by-ende-dot-app.mp3"

# (id, file under assets/sfx/, start, duration, volume, track) — see Appendix A2 for the full list
SFX = [
    ("sfx-hook",  "impact/impactSoft_medium_001.ogg", 0.12, 0.19, 0.70, 11),
    ("sfx-card",  "interface/drop_002.ogg",           0.95, 0.20, 0.55, 12),
    # … continue with every row of Appendix A2 …
]
TYPE_START, TYPE_DUR = 4.32, 1.45                      # typing ticks: every 3rd character
keys = ["003", "012", "019", "027", "005", "023", "008", "031", "015"]
for k, ch in enumerate(range(3, len(TITLE) + 1, 3)):
    t = TYPE_START + (ch / len(TITLE)) * TYPE_DUR
    SFX.append(("tick-%02d" % (k + 1), "keyboard/keypress-%s.wav" % keys[k % len(keys)], round(t, 3), 0.13, 0.30, 20 + k % 4))

LANE = {"version": 1, "lanes": [{"target": "volume", "points": [
    {"t": 0, "v": 0}, {"t": 0.15, "v": 0.06}, {"t": 0.35, "v": 0.2}, {"t": 0.6, "v": 0.35},
    {"t": 20.8, "v": 0.35}, {"t": 21.2, "v": 0.31}, {"t": 21.6, "v": 0.19}, {"t": 21.9, "v": 0.07}, {"t": TOTAL, "v": 0}]}]}
lane = json.dumps(LANE, separators=(",", ":")).replace('"', "&quot;")
print('<audio id="bgm" data-start="0" data-duration="%.2f" data-track-index="10" data-volume="1" data-automation="%s" src="%s"></audio>' % (TOTAL, lane, MUSIC))
for i, f, s, d, v, tr in SFX:
    print('<audio id="%s" data-start="%s" data-duration="%s" data-track-index="%d" data-volume="%.2f" src="assets/sfx/%s"></audio>'
          % (i, ("%.3f" % s).rstrip("0").rstrip("."), ("%.3f" % d).rstrip("0").rstrip("."), tr, v, f))

full = json.load(open("audio-full.json"))             # from extract-audio-data.py
bass = [round(sum(fr["bands"][0:3]) / 3.0, 2) for fr in full["frames"][: int(round(TOTAL * FPS)) + 1]]
print("var AUDIO={fps:%d,n:%d,bass:%s};" % (FPS, len(bass), json.dumps(bass, separators=(",", ":"))))
```

### C2 Poster + loudness master (one video encode)
```bash
cd brag-output && cp brag.mp4 brag.render.mp4          # keep the raw render
# pass 1 — measure
ffmpeg -hide_banner -nostats -i brag.render.mp4 -vn -af loudnorm=I=-16:TP=-2:LRA=11:print_format=json -f null - 2>&1 \
  | sed -n '/^{/,/^}/p' > ln.json
# build the pass-2 filter from ln.json
F=$(python3 -c "import json;m=json.load(open('ln.json'));print('loudnorm=I=-16:TP=-2:LRA=11:measured_I=%s:measured_TP=%s:measured_LRA=%s:measured_thresh=%s:offset=%s:linear=true'%(m['input_i'],m['input_tp'],m['input_lra'],m['input_thresh'],m['target_offset']))")
# pass 2 — to a WAV (a WAV carries no container timestamps that can drift)
ffmpeg -hide_banner -loglevel error -y -i brag.render.mp4 -vn -af "$F" -c:a pcm_f32le -ar 48000 -ac 2 master.wav
# verify master.wav (C3-b), then mux: poster into frame 0 + mastered audio
ffmpeg -hide_banner -loglevel error -y -i brag.render.mp4 -i brag.jpg -i master.wav \
  -filter_complex "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]" \
  -map "[v]" -map 2:a -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart brag.mp4
```
Keep `'0:a?'`-style maps quoted in zsh.

### C3 Checks
**a. Start click, tail (Phase 11)**
```python
import subprocess, numpy as np
def dec(p):  # decoded stereo float32 @48k
    raw = subprocess.run(["ffmpeg","-v","error","-i",p,"-vn","-f","f32le","-ac","2","-ar","48000","-"],capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
x = dec("brag.mp4")
print("first 0.2 s peak per 10 ms:", " ".join("%.3f" % np.abs(x[i*480:(i+1)*480]).max() for i in range(20)))
t = x[-int(1.5*48000):]
print("last 1.5 s RMS per 0.25 s:", " ".join("%.4f" % np.sqrt(np.mean(t[i*12000:(i+1)*12000]**2)) for i in range(6)))
```
**b. Sync and timing (Phase 13)** — sample count equal to the raw render's, lag 0 at ≥10 windows, contiguous packets:
```python
import collections
from numpy.fft import rfft, irfft
a, m = dec("brag.render.mp4"), dec("brag.mp4")            # or master.wav before muxing
print("samples", len(a), len(m))
def lag(x, y):
    n = len(x); cc = irfft(rfft(x, 2*n) * np.conj(rfft(y, 2*n))); k = int(np.argmax(cc)); return k - 2*n if k > n else k
print([lag(a[int(t*48000):int(t*48000)+19200].mean(1), m[int(t*48000):int(t*48000)+19200].mean(1))
       for t in (0.2,1,2,4.3,6,8.6,10.5,12.7,13.2,14.9,17,18.5,19.2,20,21,21.9)])   # all 0
def pk(f):
    out = subprocess.run(["ffprobe","-v","error","-select_streams","a:0","-show_entries","packet=pts","-of","csv=p=0",f],capture_output=True,text=True).stdout.split()
    return [int(v.strip(",")) for v in out]
p = pk("brag.mp4"); print(collections.Counter(p[i]-p[i-1] for i in range(1, len(p))))   # expect {1024: len(p)-1}
```
**c. Poster is frame 0**
```bash
ffmpeg -hide_banner -nostats -i brag.mp4 -i brag.jpg \
  -filter_complex "[0:v]select='eq(n,0)',setpts=PTS-STARTPTS[a];[a][1:v]psnr" -f null - 2>&1 | grep -o "average:[^ ]*"   # > 45
```
