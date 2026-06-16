# Image Cleanup & Restore

A general-purpose workflow for cleaning up old or low-quality photos: removes noise and minor artifacts, then sharpens the result.

## What it does

- Loads a checkpoint and encodes positive/negative prompts describing the desired cleanup (e.g. "remove scratches and dust", "avoid blur").
- Samples a refined image and saves the result.

## When to use it

Use this as a starting point whenever you need a quick "clean and sharpen" pass on a scanned photo or a noisy generation.
