# tldraw-sync

Draw on your iPad with an Apple Pencil while your Mac shows the whole board. Choose **Side by side**
on the Mac to see your Sketchboard next to the Agent canvas.

![Mac screenshot: the Sketchboard on the left shows an architecture diagram with handwritten
questions and circles. The Agent canvas on the right shows the diagram without those marks.][mac]

[mac]: docs/images/whiteboard.png

## Run it locally

On a Mac with [Bun](https://bun.sh) installed, run:

```sh
git clone https://github.com/bout3fiddy/tldraw-sync.git
cd tldraw-sync
bun install
bun link
tldraw-sync start
```

Start opens the board on your Mac. With your iPad on the same network, scan the QR code and draw.
For a cleanup, ask your agent to read `tldraw-sync --help` and clean up your sketch. The result
appears under **Cleaned**.

In a pih session with whiteboard support, use `/start_whiteboard` instead to link the board to that
session. Scan the QR code on the Mac stage and leave the stage open. On the iPad, turn on
**Interpret** before sending your sketch to get a fresh copy on the **Agent canvas**.

The board runs on your Mac and has no model of its own. Use a trusted network: sketch access has no
password and traffic is unencrypted. If your agent uses a hosted model, the sketch you share with it
goes to that provider.

## iPad Sketchboard

This screenshot shows the app in an emulated 820 × 1180 iPad portrait viewport.

<img
  src="docs/images/ipad-sketchboard.png"
  alt="Sketchboard tab with a pen palette, a small landscape sketch and a note field."
  width="360"
/>
