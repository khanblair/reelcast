# Hyperframes Composition Brief: ReelCast

## Objective
Create a short launch-style brag video for ReelCast.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: vertical — 1080x1920
- Duration: 22.12 seconds

## Source Material
- Project root: `/Users/kolaborateplatforms/BLAIR/reelcast`
- Primary files read: `IDEA.md`, `src/app/(marketing)/page.tsx`, `src/app/globals.css`, `src/app/layout.tsx`, `convex/scheduled/runPublish.ts` (real notification copy), `public/icons/icon.svg`
- Product name: ReelCast
- Tagline / strongest claim: "From raw footage to live on YouTube." / "…publish on schedule, even while you sleep."
- Key UI or visual moment to recreate: the upload dropzone, the AI Metadata card (Generating → Ready, typed title, tag chips), the Auto-Publish card (time slots, countdown, queue), and the real "🎬 Published … is now live on YouTube!" notification
- Copy that must appear verbatim:
  - "Upload your footage" / "Drop in your raw video file."
  - "10 YouTube Thumbnail Mistakes Killing Your CTR (Fix These Today)" and tags "youtube thumbnails", "increase CTR", "thumbnail design", "youtube growth"
  - "🎬 Published: “…” is now live on YouTube!"
  - "From raw footage to live on YouTube." / "Built for creators who ship daily."

## Creative Direction
- Tone preset: default
- Creative direction: quietly smug automation — "ship while you sleep"
- Interpretation: playful, clean, postable; one idea per scene, real product copy, warm restraint. The humor is the timing: the publish notification lands at 3:00 AM while the creator sleeps.
- Angle: One relatable night. You hit record, drop the file in, AI writes the metadata, the Auto-Publish queue counts down through the night, and at 3:00 the real ReelCast notification arrives — "You were asleep."
- Hook: raw `IMG_4471.mov` under the giant line "You hit record."; a cursor drags it into the upload dropzone.
- Outro / punchline: "You were asleep." → ReelCast lockup: "From raw footage to live on YouTube." / "Built for creators who ship daily."
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign
  - Stats / numbers (the landing page's "10K+ videos / 50+ channels" bar is placeholder copy and is intentionally NOT used)

## Visual Identity
- Background: `#0f0f0f` (card `#1a1a1a`, secondary `#272727`, border `#333333`)
- Text: `#f1f1f1` (muted `#aaaaaa`)
- Accent: `#ff0335` (ReelCast Red); success `#2ba640` (pill text `#4ade80` for contrast); warning `#f59e0b`
- Display font: Inter 900 (the project's own font; bundled by Hyperframes)
- Body font: Inter 400/700; JetBrains Mono for the countdown/timecode/filenames
- Visual references from the project: ReelCast play-and-cast icon (`public/icons/icon.svg`), the dark-first YouTube-inspired UI tokens, the AI Metadata and Auto-Publish cards, status pills (Generating / Ready / publishing / published)

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. Hook — 0.00–3.70s — "You hit / record." + REC indicator and viewfinder corners; file card dragged into the upload dropzone by a simulated cursor; progress fill → ✓ Uploaded
2. AI writes the metadata — 3.70–8.44s — vertical wipe in; Generating → Ready (locked to the 4.23s cue); AI title types out; 4 tag chips pop on consecutive beats; Publish Now / Schedule
3. Even while you sleep — 8.44–14.22s — slide in from the right; "Set your cadence." → "Even while you sleep."; Auto-Publish card with slots 03:00 · 12:00 · 20:00, countdown time-lapse to zero (locked to the 12.65s cue), queue rows slide in, row 1 ready → publishing → published; moon and floating "z z z"
4. Proof — 14.22–18.44s — lock screen at 3:00 with Sleep focus pill; real ReelCast notification slides in with a green ✓; caption "You were asleep."
5. Outro — 18.44–22.12s — logo springs in on the beat, "ReelCast", "From raw footage to live on YouTube.", "Built for creators who ship daily."; hold on the lockup

## Audio
- Audio role: warm bed with sparse, motion-matched accents
- Audio arc: gentle fade-in, tactile UI sounds through the working-app flow, a payoff hit when the countdown reaches zero, a success bell on the notification, a single bell on the logo, music fades under the final hold
- Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3` (114.84 BPM)
- Music treatment: starts at 0s, level 0.35 (carried by tweens; `data-volume="1"` baseline), 0.6s fade-in, fade-out 20.8–22.1s
- Music cue guidance: bundled preset (`assets/music/cues/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json`). Strong-cue locks: 3.70s (upload → metadata cut), 4.23s (Ready flip), 8.44s (Auto-Publish arrives), 12.65s (countdown zero / publishing). Beat-grid snaps: tag chips at 5.28 / 5.80 / 6.34 / 6.86; queue rows at 9.50 / 10.01 / 10.54; notification 14.76; check stamp 15.28; caption 16.34; logo 18.44.
- Audio-reactive treatment: subtle; music bass drives the background red glow's opacity/scale (per-frame data from `extract-audio-data.py`, sampled deterministically from the timeline). No waveform/equalizer visuals; text never reacts.
- Audio-coupled moments:
  - Hook lines — soft impact as "You hit" lands
  - Cursor grab / drop — click and soft drop matched to the gesture
  - AI title typing — keyboard ticks on every third character (21 ticks, randomized keypress files)
  - Tag chips — soft drop per chip, on consecutive beats
  - Queue rows — soft drop per row; card slide on scene entrance
  - Countdown zero — low-HF-risk medium impact; "published" click one beat later
  - Notification — card slide + success bell as it lands
  - Logo — bell on the icon landing
- SFX selection guidance: low/medium high-frequency-risk picks only; nothing brighter than medium; moderate density with typing ticks thinned.
- SFX analysis guidance: `skills/brag/assets/sfx/sfx-analysis.md` (safest picks used: `impactSoft_medium_001/002`, `click_003/005`, `drop_001/002/003`, `bong_001`, `card-slide-1`, `impactBell_heavy_000/003`).
- Exact SFX choice: filenames, timestamps, and volumes are in the composition's `<audio>` clips (40 clips).
- Audio files: copied into `brag-output/composition/assets/`

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core`, `hyperframes-animation`, `hyperframes-creative`, `hyperframes-keyframes`, and `hyperframes-cli`. /brag is its own workflow: do not enter the `hyperframes` entry-point intent interview and do not route into its generic promo / launch-video workflow.

Requirements met:
- Real UI/copy from the project shown throughout (dropzone, AI Metadata card, Auto-Publish card, publish notification, icon).
- All text readable; `hyperframes check` passes (lint 0 errors, runtime clean, layout 0 findings across a 24-sample + transition sweep, motion clean, WCAG AA contrast 24/24).
- Duration 22.12s (within 15–25s).
- Music + SFX layer included; audio-reactive glow present; 3+ strong-cue locks; sequential events snapped to beats (chips, rows).
- Local assets only for audio, GSAP, and the icon.
