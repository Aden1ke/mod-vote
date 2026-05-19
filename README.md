# Mod Vote

A Reddit mod tool built on Devvit that lets mod teams vote on borderline posts asynchronously.

## What it does

- Mod clicks **Start Mod Vote** on any post
- All mods get a modmail notification with a link to vote
- Each mod votes: Remove, Keep, or Needs Discussion
- When the vote closes, the winning action executes automatically
- Results posted to modmail with full tally

## Features

- Anonymous or named voting (configurable per vote)
- Quorum enforcement — minimum votes required before a result is executed
- Manual close or auto-expire at deadline
- Full vote history stored in Redis
- Zero external dependencies — runs entirely on Devvit

## Built with

- Devvit (Mod Tool template)
- Hono (server routing)
- Redis (vote storage)
- Reddit Modmail API (notifications)

## Built for

Reddit Mod Tools Hackathon — May 2026
