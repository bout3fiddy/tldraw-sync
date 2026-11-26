# tldraw-sync

Draw on your iPad with an Apple Pencil while your Mac shows the whole board. Zoom in to label one
arrow in a checkout flow. On a call, everyone watching your Mac still sees where that arrow goes.

Ask your coding agent to clean up the flow. It can turn two rough boxes and a handwritten “writes”
arrow into a typeset diagram on a separate canvas, without changing your ink. Choose **Side by
side** to compare the two. A picture next to the diagram keeps the strokes you drew.

![The Mac’s Side by side view shows the original strokes and landscape on the left and an
API → Postgres diagram beside the same landscape on the right.][whiteboard]

[whiteboard]: docs/images/whiteboard.png

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
