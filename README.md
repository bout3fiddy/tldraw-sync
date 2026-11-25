# tldraw-sync

Sketch a messy diagram on your iPad. See the whole thing on your Mac. Ask the coding agent you
already use to clean it up, and you get a tidy copy next to your sketch. Your ink stays untouched.

## Why

Thinking with a pen is fast. Boxes lean, arrows wobble and labels squeeze into corners, and that is
fine while you are working something out. It is less fine when you want to share it, or come back to
it a week later.

tldraw-sync keeps the two apart:

- **Sketch** is your ink, drawn with the Apple Pencil. Nothing but you ever changes it.
- **Cleaned** is a tidy diagram of the sketch, made by your agent. It sits on a separate canvas, so
  you can look at either one, or both side by side.

The Mac shows the whole drawing at all times, even while you zoom in on a detail on the iPad. That
makes it easy to share the Mac screen on a call while you draw.

Write at any zoom. The pen is as heavy on the screen zoomed far out as it is close in, and ink never
thins to a hairline on either screen, however large the board grows.

## An example

Say you are working through a checkout flow and sketch this in a few seconds:

- a lopsided box with "API" scrawled inside
- a wobbly oval labelled "Orders DB"
- a crooked arrow from the box to the oval, with "writes" written along it
- "Checkout" written above it all

You say to your agent: "clean up my sketch". The agent looks at the drawing, and a moment later the
Cleaned tab shows the same diagram in neat shapes: a straight-edged "API" box, an "Orders DB"
ellipse, a “writes” arrow between them, and a “Checkout” title. Switch to **Side by side** to
compare it with your handwriting. Keep drawing and the board marks the cleanup as out of date.
Earlier cleanups are kept, and your agent can bring one back.

It works for notes as well as diagrams. The cleanup keeps your arrangement: what you wrote side by
side stays side by side, a heading keeps its list under it, and adding a line to one section leaves
the others where they were. It is always drawn in black ink, like a whiteboard.

## Quickstart

You need a Mac with [Bun](https://bun.sh), an iPad with an Apple Pencil, both on the same network,
and a coding agent that can run commands and read images, such as Claude Code or Codex.

1. Install the command:

   ```bash
   git clone https://github.com/bout3fiddy/tldraw-sync.git
   cd tldraw-sync
   bun install
   bun link
   ```

   `bun link` puts `tldraw-sync` in `~/.bun/bin`. If your shell cannot find it, add
   `export PATH="$HOME/.bun/bin:$PATH"` to `~/.zshrc` and open a new terminal.

2. Start the board:

   ```bash
   tldraw-sync start
   ```

   It runs in the background, prints a QR code and opens the presentation page in your Mac's
   browser.

3. Scan the QR code with the iPad camera and draw. Only the Pencil draws; two fingers pan and zoom.
   Add the page to the Home Screen once and it opens full screen with one tap.

4. Ask your agent: “Use `tldraw-sync --help` to find my board and clean up my sketch.” Then open the
   **Cleaned** tab on either device.

5. Stop the board when you are done. Your drawing is saved and comes back on the next start.

   ```bash
   tldraw-sync stop
   ```

To update, stop the board, run `git pull` in the clone, then start it again.

## Draw alongside a pih session

In a pih host with whiteboard support, use `/start_whiteboard`. It opens the Mac stage and links a
board to **this session**. Run it again to reopen the same board. Scan the **stage QR** on the iPad:
this pairs the two request buttons for that board in that browser tab. The plain draw address lets
someone draw, but does not pair their event controls. Use **Pair iPad** on the Mac to scan again.
Keep the stage open so it can render the PNG your agent reads.

- **Notify agent** asks the agent to look at the current sketch as conversation context.
- **Interpret sketchboard** asks for a faithful, typeset copy in **Agent canvas → Interpretation**.
  **Ideas** is separate: the agent can add explanations, questions and proposals without changing
  the interpretation. Both layers are read-only on the iPad.
- **Replace sketchboard** copies the layer you are viewing into the sketch as editable shapes and
  removes the current ink. Only do this when you want the replacement. **Undo** restores the ink in
  one step. Use **Select shapes** to move or edit items. Neither agent layer changes.

A request is queued only when the Mac has the ink you tapped on. If you see “Ink is syncing”, wait
for the connection and tap again. The board keeps up to 64 requests; a full pending queue refuses
new requests instead of discarding undelivered work. Receipt, work and completion are separate
states. `/stop_whiteboard` detaches the pih listener without deleting the board or stopping the Mac.

For local integrations, `whiteboard-link --owner <id> --out <absolute-file> --json` installs a
private binding. Pass it with `--binding` to `whiteboard-poll`, `whiteboard-ack`,
`whiteboard-snapshot` and `whiteboard-publish`. See each command’s `--help`. Both layers require the
snapshot’s `base_revision`; Interpretation also requires the sketch to be unchanged. Ideas retain
their source even if drawing continues. Snapshot files are private workspaces under `--out` (or the
system temporary directory); remove them when done. Legacy `cleanup-*` still uses Interpretation.

Use a trusted LAN. Pairing limits the **new controls**; it does not authenticate sketch sync,
protect drawing reads or encrypt traffic. Anyone with the stage QR can send requests on that board.
Never share a binding file. Words on a board are input, not instructions to run commands or approve
destructive operations.

## Several boards

Keep a separate board for each topic. Tap the **Boards** button in the top-left corner to open the
list, start a **New board**, switch between boards, or rename one. Each board has its own sketch,
cleanup history, QR code and address, so you can open two boards side by side in separate browser
windows. The board you had before is still there, at the same addresses.

A new board is untitled until you name it. If you haven't named it by the first cleanup, your agent
suggests a short title. A name you give always wins. Agents find boards with
`tldraw-sync session-list` and pick one with `--session <id>`.

## What runs where

The board runs entirely on your Mac and serves your iPad over the local network. It has no cloud
service, no account and no model of its own. Your drawing is saved in `data/` inside the clone,
unless you set `BOARD_DATA_DIR`. Each extra board gets its own folder in `data/sessions/`.

The cleanup is done by your agent, not by the board. The agent reads an image of your sketch, writes
the tidy diagram as plain data, and hands it back to the board, which checks it before showing it.
If your agent uses a hosted model, the image of your sketch, handwriting included, goes to that
model's provider like anything else you show the agent. Use an agent you are comfortable sharing the
drawing with.

The board has no password. Use a network you trust. For more commands, run `tldraw-sync --help`.
