# Idea: a standalone "brag studio" project (parked)

Status: **parked, not started.** Captured from a 2026-09-18 discussion so the idea isn't lost. See [`BRAG-VIDEO-GUIDE.md`](BRAG-VIDEO-GUIDE.md) for how brag videos are made today (skill + Hyperframes, per the current setup).

## The idea

Instead of the `brag` skill living per-agent (`~/.agents/skills/brag`, `~/.claude/skills/brag`, one copy per harness), pull it out into its own repo: a small dedicated project you point at any target repo to generate its launch video, usable the same way from Claude Code, dsh/DeepSeek, or any other agent.

## Why (and why not "a project like Claude/Gemini")

Not a general agent — Claude Code, Gemini CLI, and dsh already are that, and duplicating them would be wasted effort. The actual value is narrower:

- **Model independence** — same result regardless of which harness/model drives it.
- **Less babysitting** — the fragile, mechanical steps (lint fixes, baselines, audio lanes, loudness mastering) become tested code instead of instructions a model has to get right every time.
- **Safety by construction** — the agent only gets write access to the studio's own `out/` directory, never the target repo. Would have prevented the kotlintutor session's unasked build/emulator/push.
- **One home** — assets, scene templates, and rendered outputs in one place instead of scattered `brag-output/` folders per project.

## Shape (if built)

1. **Deterministic CLI core** — preflight, scaffold, audio-tag generation, lint/check, render, audio QA, poster, loudness master, verify. Appendix C of `BRAG-VIDEO-GUIDE.md` already has working, tested scripts for most of this (one reproduces the delivered video byte-for-byte) — they'd become subcommands + regression tests.
2. **Scene templates driven by a JSON storyboard** — the biggest reliability win. Turn the reference composition into parameterized scenes so the model only supplies a small spec (copy, colors, timings); baselines, hidden-overlay state, layout attributes, and the audio volume lane are built in, not hand-authored per run.
3. **Thin model layer** — the model only does the creative steps (read the target repo, write the plan/storyboard, share copy, review rendered frames), through a short allow-listed tool set.
4. **Repo layout** — separate repo; target project passed as a path; outputs under `out/<project>/`; the studio repo is the only writable workspace.

## Constraints to resolve before building

- **Licensing.** brag itself is MIT (Shunit Haviv Hakimi) — fine to fork. Hyperframes is Apache-2.0. The bundled music (ende.app "Happy Beats") and SFX (Kenney) have **unverified redistribution terms** — brag's own README flags this. Don't ship those assets in a public project until confirmed, or swap in owned/royalty-free tracks.
- **Overlap.** Hyperframes already ships `product-launch-video`, `pr-to-video`, `general-video` skills. Differentiate on reliability/templates/cross-model use, not on being "another video skill."
- **Churn.** Hyperframes (0.8.x) and dsh (0.1.x) are both pre-1.0 and change fast — pin versions, keep golden tests.
- **Open question that changes scope:** personal tool for your own projects, or something you'd release/share? Decides the music/asset licensing work and whether the model layer + UI (step 3/4 above) are worth building at all.

## Next step, when picked back up

Steps 1–2 (CLI skeleton + golden test from the existing reference composition) are useful even if steps 3–4 never happen — start there.
