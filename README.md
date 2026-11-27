# tldraw-sync

Draw on your iPad with an Apple Pencil while your Mac shows the whole board. Switch between the
**Sketchboard**, the **Agent canvas** and the board's **Chat** with the tabs at the top right.

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

Open **Boards** on either device to switch boards. Use a board’s **⋮** menu to rename or delete it.
The home addresses (`/` on the Mac and `/draw` on the iPad) open the oldest remaining board. Delete
all boards and the list stays empty until you select **New board**.

In a pih session with whiteboard support, use `/start_whiteboard` instead to link the board to that
session. Scan the QR code on the Mac stage and leave the stage open. Open **Chat** on the iPad or
the Mac and write to the agent linked to that board. Your words go alone: the agent sees no sketch
unless you press **Add sketch**, which sends the sketch as it is at that moment. The agent answers
in the chat, under your message, and says so when it draws on the **Agent canvas**; **Open** takes
you there. A dot on **Chat** means an answer you have not read on this device. **Replace
sketchboard** copies the Agent canvas into your sketch as shapes you can edit, and Undo brings your
ink back.

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
