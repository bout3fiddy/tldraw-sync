# tldraw-sync

Draw on your iPad with an Apple Pencil while your Mac shows the whole board. Your ink and the
agent's drawing share one dotted canvas: the agent's shapes lie under your ink, printed in violet.

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
Ask your agent to read `tldraw-sync --help`: it can then fetch your sketch as a picture whenever you
mention it.

Press the button beside the board's name, at the top left, to switch boards. Use a board's **⋮**
menu to rename or delete it. The menu for the board on screen also clears your ink or replaces it
with the agent's drawing, and Undo takes either back. The home addresses (`/` on the Mac and `/draw`
on the iPad) open the oldest remaining board. Delete all boards and the list stays empty until you
select **New board**.

In a pih session with whiteboard support, use `/start_whiteboard` instead to link the board to that
session. Scan the QR code on the Mac stage and leave the stage open. Open **Chat** at the top right
on the iPad or the Mac and write to the agent linked to that board. Your words go alone: the agent
sees no sketch unless you press **Add sketch**, which sends the sketch as it is at that moment. The
agent answers in the chat, under your message, and draws on the canvas; **Show on canvas** brings
its drawing into view. A violet square on **Chat** means an answer you have not read on this device.

## One canvas

The pen and eraser only ever touch your ink: the agent's drawing lies under it, and a new revision
changes only that drawing. The key at the foot of the canvas says which revision is shown. When one
arrives it says so for a moment, with the revision before it a press away. Looking back never
restores or publishes anything, and nothing the agent does moves your view. Press **Your ink** or
**Agent** in the key to bring either into view.

Tap an agent shape with a finger, or click it, to see whose it is. **Take into my sketch** copies it
into your ink exactly where it is, as shapes you can edit, and Undo takes the copy back. The agent's
drawing fades beneath your copy. The copy is refused if the agent has drawn a newer revision, or
your sketch changed, since you chose the shape: tap it again.

Each board has its own chat, kept on the Mac with the board. Only a device paired by that board's QR
code, and the Mac stage itself, can read it. A draft and a message the Mac has not confirmed stay on
the device: if the Mac is lost, press **Send again** once it is back, and nothing is sent twice.

The board runs on your Mac and has no model of its own. Use a trusted network: sketch access has no
password and traffic is unencrypted. If your agent uses a hosted model, the messages and sketches
you share with it go to that provider.

## iPad Sketchboard

On an iPad in landscape, use the pen palette to annotate a diagram on the Sketchboard.

<img
  src="docs/images/ipad-sketchboard.png"
  alt="Sketchboard with an annotated architecture diagram, pen palette and optional note field."
/>
