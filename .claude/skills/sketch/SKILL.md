---
name: sketch
description: Fetch the latest drawing from the running board and read it
triggers:
  - check the sketch
  - check my sketch
  - look at my sketch
  - analyze the sketch
  - what did I draw
---

# Sketch

When the user asks you to look at their sketch, fetch it and read it.

## Step 1: Fetch the drawing

```bash
curl -s -o "$TMPDIR/board.png" -w "%{http_code}" http://localhost:5173/api/drawing.png
```

Check the status code before reading the file:

- `200`: the file is the current drawing.
- `404`: the board is empty. Say so.
- `503`: the image is behind the drawing. The response body says why. Usually the stage is
  not open: ask the user to open `http://localhost:5173` on the Mac, then fetch again.
- Connection refused: the board is not running. Ask the user to run `bun start`.

A `200` is always the current drawing. The server never returns an out-of-date image.

## Step 2: Read it

Read the saved PNG with the Read tool.

If handwriting is hard to make out, `GET http://localhost:5173/api/drawing.json` returns the
shapes with their positions, which helps tell separate strokes and groups apart.

## Step 3: Respond to what the conversation needs

The drawing is context for whatever the user is asking. Answer their question about it. If
they asked nothing specific, describe what is on the board and what looks unresolved, such
as a question written beside a component.

## Prerequisites

- The board is running: `bun start`
- The stage is open in a browser on the Mac: `http://localhost:5173`
