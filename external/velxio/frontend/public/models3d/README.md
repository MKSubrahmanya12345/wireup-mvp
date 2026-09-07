# models3d — CAD 3D asset registry

The new **CAD 3D view** (Option A) renders **only** parts that have a registered
GLB here. A part with no registered model is simply omitted from the 3D scene
— there is no placeholder slab and no procedural fallback body. When no models
are registered at all, the 3D view shows a clear empty-state message instead of
crashing.

## What lives here

```
public/models3d/
  manifest.json          # the registry table (this file)
  build_models3d.py      # one-command STEP -> GLB builder (cascadio, no Blender)
  build-models3d.ps1     # Windows PowerShell wrapper for the same builder
  requirements.txt       # Python deps for the builder
  <key>/<key>.glb        # the actual model assets (produced by build_models3d.py)
  <key>/textures/        # optional PBR textures (referenced by manifest)
```

`public/` is served at the app root, so a manifest `file: "arduino-uno/arduino-uno.glb"`
resolves to `/models3d/arduino-uno/arduino-uno.glb`.

## manifest.json contract

```json
{
  "version": 1,
  "models": {
    "<key>": {
      "file": "<path-under-models3d>.glb",
      "pinNodes": ["<pin-name>", "..."],
      "bench": {
        "position": [x, y, z],
        "rotation": [x, y, z],
        "scale": 1
      },
      "materials": {
        "baseColorMap": "arduino-uno/textures/diffuse.png",
        "baseColor": [0.5, 0.5, 0.5]
      }
    }
  }
}
```

- **`<key>`** — the lookup key. For a **board** it is its `boardKind`
  (e.g. `arduino-uno`). For a **component** it is its `metadataId`
  (e.g. `servo`).
- **`pinNodes`** — the Node/Empty names inside the GLB that correspond to the
  part's connection points. The frontend resolves wire endpoints via
  `getObjectByName(pinName).getWorldPosition()`, so **these names must match the
  wire endpoints exactly**. `pinNodes` is documentation/introspection; the actual
  lookup reads object names.
- **`bench`** — optional placement. `position` is applied as an offset on top of
  the automatic grid layout, `rotation` (radians, Y) and `scale` tune the pose.

## Pin names (the critical contract)

Wire endpoints carry the pin `name` the web component exposes in `pinInfo`.
The Blender side must create an Empty with **exactly** that name inside the GLB.
Verified names:

| Key           | Pin names                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `arduino-uno` | `0`,`1`,`2`,`3`,`4`,`5`,`6`,`7`,`8`,`9`,`10`,`11`,`12`,`13`, `A0`–`A5`, `GND.1`, `GND.2`, `3V3`, `VIN`, `5V`, `RESET` |
| `servo`       | `SIGNAL`, `VCC`, `GND`                                                                                      |

Important notes:

- Arduino Uno digital pins are exposed **numerically** (`0`–`13`), not `D0`–`D13`.
  The frontend already tries aliases (`13` ↔ `D13`, `3V3` ↔ `3.3V`, `GND.1` ↔
  `GND1`), but **prefer the exact names above**.
- `GND.1` is the most at risk of being sanitized/deduped by the exporter. Verify
  it round-trips: reopen the GLB and enumerate names before relying on wiring.

## Verify an export

`python build_models3d.py --all` runs a self-check at the end (every contract pin
name must round-trip, no Draco, bounding box centred). To list the node names of
an existing GLB by hand:

```bash
python - <<'EOF'
import json, struct
data = open("sg90/sg90.glb", "rb").read()
n, = struct.unpack_from("<I", data, 12)          # JSON chunk length
glb = json.loads(data[20:20 + n])
for node in glb.get("nodes", []):
    print(repr(node.get("name")))
EOF
```

then in the running app, open the 3D view and confirm wires draw between the two
registered parts.

## Produce the assets (one command, no Blender)

`build_models3d.py` reads the STEP natively through OpenCASCADE (`cascadio`),
exports an uncompressed GLB (no Draco, so no CDN decoder is needed), wires in
the pin empties and the `servo_horn` animation group, and refreshes
`manifest.json` (merge — never clobbers other keys). It self-verifies that the
contract pin names round-trip and the bounding box is centred.

```bash
pip install -r requirements.txt
python build_models3d.py --all
# Windows:  py -3 build_models3d.py --all            (or build-models3d.ps1)
```

The old `export_glb.py` (Blender host) is obsolete: Blender 5.2.1 has no STEP
importer, so the cascadio pipeline replaces it.
