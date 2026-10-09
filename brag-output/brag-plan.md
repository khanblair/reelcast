# Brag Plan: ReelCast

## What is this app?
ReelCast takes a creator from raw footage to live on YouTube: upload a file, AI writes the title/description/tags, and an auto-publish queue posts it on schedule — while you sleep.

## The angle
"Ship while you sleep." Quietly smug automation. The whole video is one relatable night: you hit record, drop the file in, go to bed, and ReelCast publishes at 3:00 AM. The punchline is that the notification arrives while you're asleep. Specific to ReelCast because every beat is a real ReelCast surface: the upload dropzone, the AI Metadata card, the Auto-Publish queue with time slots, and the real "🎬 Published … is now live on YouTube!" notification.

## Hook (first 2-3 seconds)
Raw file `IMG_4471.mov` slams in under the giant line **"You hit record."** (the site's own "everything after you hit record" line). A cursor drags the file into an "Upload your footage" dropzone and the progress bar fills.

## Key moments (the middle)
- Status pill flips Generating → **Ready**; the AI title types itself out ("10 YouTube Thumbnail Mistakes Killing Your CTR (Fix These Today)") and four tag chips pop in one by one.
- Auto-Publish card: time slots 03:00 · 12:00 · 20:00, the countdown time-lapses to 00:00:00 while a moon and floating "z z z" drift by; the top queue row flips ready → publishing → **published**.
- Phone lock screen at 3:00 with the Sleep focus pill: the real ReelCast notification slides in.

## Outro / punchline
Caption lands: **"You were asleep."** Then logo lockup: ReelCast — "From raw footage to live on YouTube." / "Built for creators who ship daily."

## User flow worth showing
Entry → key action → result: drop raw video in (upload) → AI writes metadata in seconds → auto-publish fires on schedule and pings you "Published … is now live on YouTube!". This is the working app, not the landing page.

## Tone
- Preset: default
- Creative direction: quietly smug automation — "ship while you sleep"
- Interpretation: playful and clean; comfortable pacing with one idea per scene, real product copy, warm restraint (the humor is the timing of the notification, not jokes on screen).

## Format: vertical — 1080x1920
## Duration: 22.1s (scene changes locked to the music's beat grid)

## Visual identity (from the project)
- Background: #0f0f0f (card #1a1a1a, secondary #272727, border #333333)
- Accent: #ff0335 (ReelCast Red); success #2ba640; warning #f59e0b
- Text: #f1f1f1 (muted #aaaaaa)
- Display font: Inter 900 (headlines) — the project's own font
- Body font: Inter 400/700; JetBrains Mono for the countdown/timecode
- Strongest visual element: the AI Metadata card and the Auto-Publish countdown/queue, plus the ReelCast play-and-cast icon (`public/icons/icon.svg`)

## Share copy (draft)
Raw footage in. Live on YouTube out. I was asleep. — ReelCast

## Audio direction
- Role: warm bed with sparse, motion-matched accents
- Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3` (114.8 BPM, mid-energy, best for the default tone)
- Music treatment: starts at 0s, volume ~0.35, fade out over the last ~1.3s under the logo
- Music cue guidance: bundled preset read (`vol-9`, 114.84 BPM). Strong-cue locks: 3.70s (upload → metadata cut), 8.44s (Auto-Publish card arrives), 12.65s (countdown hits zero / publishing). Beat grid used for the tag chips (5.28, 5.80, 6.34, 6.86) and scene boundaries (14.22, 18.44).
- Audio-reactive treatment: subtle; music bass/RMS makes the background red glow breathe. No waveform/equalizer visuals.
- SFX posture: moderate, motion-matched, low high-frequency risk picks
- Audio-coupled moments: hook slam, cursor click/drop, keyboard ticks while the AI title types, chip pops, card slide-ins, payoff impact at zero, success bell on the notification, logo bell
- Restraint rule: no SFX on every beat; typing ticks thinned to every third character; nothing brighter than medium HF-risk.

## Storyboard

### Scene 1 — Hook — 0.00–3.70s
"You hit" / "record." slam in (record in red). REC indicator blinks top-left with viewfinder corner marks. File card `IMG_4471.mov · 812 MB` drops in, a cursor grabs it and drags it into the "Upload your footage" dropzone; progress bar fills, green ✓ at completion.
Sequential/interaction: yes — simulated cursor grab → drag → drop, then a progress fill
Audio intent: confident, tactile opening
Audio-coupled idea: hook slam (soft impact), click on grab, soft drop on landing, tick when upload completes
Music: bed fades in from the first beat
Transition mood: clean wipe (panel slides up) → Scene 2

### Scene 2 — AI writes the metadata — 3.70–8.44s
Overlay headline "AI writes / the metadata." over the AI Metadata card. Pill Generating → Ready (locked to the 4.23s cue), "Generated in 4.2s" badge, title types out character by character, 4 tag chips pop in on consecutive beats (5.28 / 5.80 / 6.34 / 6.86; held ≥1.5s after the last), Publish Now / Schedule buttons fade in.
Sequential/interaction: yes — typed title, then chips pop one by one (short labels, full set held)
Audio intent: satisfying "it did it for me"
Audio-coupled idea: keyboard ticks on every third typed character; soft pop per chip
Music: same bed
Transition mood: clean slide → Scene 3

### Scene 3 — Even while you sleep — 8.44–14.22s
Headline "Set your / cadence." then "Even while / you sleep." over the Auto-Publish card: countdown time-lapses to 00:00:00 (locked to the 12.65s cue), slot chips 03:00 · 12:00 · 20:00, queue of 3 videos with the first flipping ready → publishing → published. Moon + floating "z z z".
Sequential/interaction: yes — three queue rows slide in one by one; countdown time-lapse
Audio intent: quiet anticipation, then a payoff
Audio-coupled idea: card slide on arrival, soft drops per row, payoff impact at zero, click on "published"
Music: same bed, carries the build
Transition mood: soft crossfade → Scene 4

### Scene 4 — Proof — 14.22–18.44s
Dark lock screen: big "3:00" clock, "Sleep" focus pill, moon. The real notification slides in: "🎬 Published: "10 YouTube Thumbnail Mistakes…" is now live on YouTube!" with a green ✓. Caption lands: "You were asleep."
Sequential/interaction: yes — notification slides in, then check stamps, then the caption
Audio intent: success, warm payoff
Audio-coupled idea: card slide + success bell as the notification lands
Music: same bed
Transition mood: clean → Scene 5

### Scene 5 — Outro — 18.44–22.12s
ReelCast icon springs in on the beat, wordmark "ReelCast", tagline "From raw footage to live on YouTube.", then "Built for creators who ship daily." Hold on the lockup.
Sequential/interaction: none
Audio intent: settle and land
Audio-coupled idea: logo bell on the icon landing; music fades out under the hold
Music: fade out
Transition mood: hold (ends on the lockup, not black)

**Music mood for this video:** upbeat, warm
**Audio summary:** a warm mid-tempo bed with tactile UI sounds through the working-app flow, a payoff hit when the countdown hits zero, a success bell on the notification, and a single bell on the logo.
