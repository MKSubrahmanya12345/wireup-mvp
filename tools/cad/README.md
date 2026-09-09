# Wireup CAD asset builder

This directory is the **offline / CI** half of Wireup's 3D pipeline. It turns a
*known, reviewed* STEP assembly into a GLB that the Admin CAD Studio can load
natively in Three.js.

It deliberately does **not** run inside a Next.js request and does **not**
pretend that a text component description can produce a correct PCB layout.

## What the builder does

```text
verified manufacturer / KiCad package STEP
  -> OpenCASCADE (cascadio, headless)
  -> GLB mesh assembly
  -> millimetre scene root + named pin anchors + PBR material rules
  -> structural validation + public/models3d/<part>/<part>.glb
  -> reviewed entry in cad-helper/reference-assets.ts
```

`build_glb.py` accepts an asset manifest, validates its anchor contract, and
keeps all geometry work out of the browser and API runtime. Three.js only has
to fetch a normal GLB and apply studio lighting / interaction.

## Local or CI invocation

```bash
python -m venv .venv-cad
. .venv-cad/bin/activate
python -m pip install -r tools/cad/requirements.txt
python tools/cad/build_glb.py --asset path/to/part.asset.json
```

Start with [`asset-manifest.example.json`](./asset-manifest.example.json).
The source and output paths in a manifest are relative to that manifest file.
The conversion is headless: no Blender, FreeCAD, KiCad GUI, or browser is
needed in the build job.

## Asset-manifest contract

| Field | Meaning |
| --- | --- |
| `id` | Stable catalog / registry identifier. |
| `source` | Existing `.step` / `.stp` assembly that has passed provenance review. |
| `output` | Public GLB path the Next app will serve. |
| `pinAnchors` | Exact `name` + `[x, y, z]` in source CAD **millimetres**. Builder injects named glTF empty nodes. |
| `materialHints` | Explicit mesh-name matching rules for base colour, metallic and roughness. |
| `maxBytes` | Optional guardrail; defaults to 15 MB. |

The builder adds `wireup_model_mm`, a root scaled from cascadio's metre source
frame to Wireup's millimetre scene. It writes only named anchor empties—no
clickable/visible markers. The Studio decides whether to show anchor markers.

## What still needs an upstream source

A KiCad `Packages3D` model is usable only when the chosen footprint actually
maps to that exact package. Arduino-like boards, custom breakout boards and
other assemblies need a real STEP / CAD source or an intentionally authored
parametric model. Generating `.kicad_pcb` from a prose spec remains a separate
EDA problem: it requires a schematic/netlist, footprint mapping, placement,
clearances and routing rules.

If an exact source is missing, leave the part **out of the reference registry**.
The Admin Studio renders Wireup's shaded parametric fallback and labels it as
such; it must not be advertised as a manufacturer-grade model.

## Registering a successful build

After validation, add the public URL, detail statement and licensing/provenance
note to `cad-helper/reference-assets.ts`, then add `visualAsset: { key: ... }`
to the reviewed component preset. This is intentionally a human review step.

The current Arduino Uno demo is a mirrored asset from the repository's vendored
Velxio registry. Its attribution and deployment restriction live in
`public/models3d/ATTRIBUTION.md`; resolve that licensing choice before using it
in a proprietary hosted release.
