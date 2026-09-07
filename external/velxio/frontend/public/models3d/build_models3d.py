#!/usr/bin/env python3
"""
build_models3d.py — one-command STEP -> GLB asset builder for the CAD 3D view.

Reads STEP natively via OpenCASCADE (the `cascadio` Python package — NO
Blender, NO FreeCAD, NO OpenGL, no GUI), exports an uncompressed GLB (Draco
OFF), then post-processes the glTF:

  * scales to millimetres and re-centres the bounding-box centre at the origin
    (frontend auto-layout drops each part at its own spot),
  * adds named pin EMPTY nodes (glTF nodes with no mesh — invisible anchors the
    frontend uses for wire endpoints; no mesh = nothing renders),
  * adds an animated `servo_horn` group for the SG90 so the 3D view can spin it,
  * adds sensible default materials for the Uno (its STEP carries no colours),
  * refreshes manifest.json (merge — never clobbers other keys).

Usage (builds both parts + manifest — the one command to run):

    python build_models3d.py --all
    # Windows:  py -3 build_models3d.py --all   (or use build-models3d.ps1)

Single part (--step/--out/--key must be used together):

    python build_models3d.py \
        --step "cad/arduino-uno-r3-1.snapshot.5/arduino uno.STEP" \
        --out external/velxio/frontend/public/models3d/arduino-uno/arduino-uno.glb \
        --key arduino-uno

Requires:  pip install -r requirements.txt   (just: cascadio)

Background: the previous Blender script (export_glb.py) was abandoned because
Blender 5.2.1 has no STEP importer and does not load the STL/glTF I/O add-ons
headless. OpenCASCADE reads STEP and writes glTF directly, so the whole
pipeline is one command with no Blender and no manual STEP->STL step.

Pin coordinates below were measured from the actual CAD meshes (2.54 mm
header pitch, mm units, Y-up in the cascadio export).
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import tempfile

try:
    import cascadio
except ImportError:  # pragma: no cover - friendly error
    sys.exit(
        "cascadio is required (OpenCASCADE STEP -> glTF converter).\n"
        "Install it with:  pip install -r requirements.txt   (i.e. pip install cascadio)"
    )

import numpy as np

# ---------------------------------------------------------------------------
# Pin contract — positions in CAD millimetres (raw STEP frame, Y-up).
# Measured from the actual geometry: left digital column x=-50.8, right
# power/analog column x=-2.54, header pin tops at y=8.5, 2.54mm pitch.
# ---------------------------------------------------------------------------

# The 26 pins the manifest must list, exactly as the handoff specifies:
# 0-13, A0-A5, GND.1, GND.2, 3V3, VIN, 5V, RESET.
UNO_PINS = {
    # Left digital header — 10-pin (A5.2..8), then 8-pin (7..0).
    "GND.1": (-50.795, 8.5, -26.42),
    "13": (-50.795, 8.5, -28.96),
    "12": (-50.795, 8.5, -31.50),
    "11": (-50.795, 8.5, -34.04),
    "10": (-50.795, 8.5, -36.58),
    "9": (-50.795, 8.5, -39.12),
    "8": (-50.795, 8.5, -41.66),
    "7": (-50.795, 8.5, -45.72),
    "6": (-50.795, 8.5, -48.26),
    "5": (-50.795, 8.5, -50.80),
    "4": (-50.795, 8.5, -53.34),
    "3": (-50.795, 8.5, -55.88),
    "2": (-50.795, 8.5, -58.42),
    "1": (-50.795, 8.5, -60.96),
    "0": (-50.795, 8.5, -63.50),
    # Right power header — 8 positions (top hole unpopulated on the R3),
    # then analog header.
    "RESET": (-2.54, 8.5, -33.02),
    "3V3": (-2.54, 8.5, -35.56),
    "5V": (-2.54, 8.5, -38.10),
    "GND.2": (-2.54, 8.5, -40.64),
    "VIN": (-2.54, 8.5, -45.72),
    "A0": (-2.54, 8.5, -50.80),
    "A1": (-2.54, 8.5, -53.34),
    "A2": (-2.54, 8.5, -55.88),
    "A3": (-2.54, 8.5, -58.42),
    "A4": (-2.54, 8.5, -60.96),
    "A5": (-2.54, 8.5, -63.50),
}

# Extra anchors the real Uno exposes (wokwi element + common example data) so
# 3D wires still resolve, e.g. AREF / IOREF / GND.3 / A4.2 / A5.2. Kept as
# GLB nodes only (NOT listed in manifest pinNodes, which stays to contract).
UNO_AUX_PINS = {
    "A5.2": (-50.795, 8.5, -18.80),
    "A4.2": (-50.795, 8.5, -21.34),
    "AREF": (-50.795, 8.5, -23.88),
    "IOREF": (-2.54, 8.5, -30.48),
    "GND.3": (-2.54, 8.5, -43.18),
}

# Spelling aliases the frontend's resolver may ask for (same positions).
UNO_ALIASES = {
    "3.3V": "3V3",
    "GND1": "GND.1",
    "GND2": "GND.2",
    "GND3": "GND.3",
    "5.0V": "5V",
}

# SG90: cable relief nub on the body's bottom face (y=6.17, ridge at x=-4.3,
# running along z). Connector pins hang below it, 2.54 mm pitch in x.
SERVO_PINS = {
    "SIGNAL": (-1.76, 4.5, 27.78),
    "VCC": (-4.30, 4.5, 27.78),
    "GND": (-6.84, 4.5, 27.78),
}

# wokwi-servo exposes PWM / V+ / GND — extra anchors, same positions.
SERVO_ALIASES = {
    "PWM": "SIGNAL",
    "V+": "VCC",
}

# Spinning horn assembly: parts on the output shaft axis. Axis measured from
# the CAD: x=1.52, z=27.78 (the .2/.3/.4 horns + .6 shaft screw hang on it).
SERVO_HORN = {
    "name": "servo_horn",
    "center_mm": (1.52, 36.00, 27.78),
    # match by the ".N_" suffix in the STEP part names
    "mesh_suffixes": (".2_", ".3_", ".4_", ".6_"),
}

# DHT22 (AM2302) breakout, measured from cad/dht22/dht22.stl.
# The STL is already in a Y-up frame (pins run +Y, sensor grille faces +Z,
# PCB vertical), so the FreeCAD-style Z-up reading of the same anchors is
# (X, -Z, Y) and the doc's (X,Y,Z)->(X,Z,-Y) conversion yields these again.
# Right-angle header: 3 populated blades at 2.54 mm pitch (0.635 mm wide,
# tips at Y=21.486, blade centre Z=5.544); pin-3 (NC) slot is unpopulated on
# this breakout -> virtual anchor on the same 2.54 mm grid. Front view
# (grille towards viewer) left->right = VCC, SDA, NC, GND (wokwi pinInfo
# order, numbers 1..4). Anchors sit 0.4 mm below the blade tips so wires
# land ON the pins. Raw CAD frame, like UNO_PINS/SERVO_PINS (the wrapper
# recentres mesh and pins together).
DHT22_PINS = {
    "VCC": (-2.490, 21.086, 5.544),
    "SDA": (0.050, 21.086, 5.544),
    "NC": (1.320, 21.086, 5.544),
    "GND": (2.590, 21.086, 5.544),
}

# Uno default colours (its STEP has no material data). Sorted longest-first
# so specific names win.
UNO_MATERIAL_HINTS = [
    ("unoboard blue", (0.08, 0.28, 0.52, 1.0)),
    ("power jack", (0.10, 0.10, 0.10, 1.0)),
    ("resistor", (0.42, 0.20, 0.14, 1.0)),
    ("crystal", (0.70, 0.70, 0.68, 1.0)),
    ("header", (0.16, 0.16, 0.18, 1.0)),
    ("diode", (0.15, 0.15, 0.15, 1.0)),
    ("reset", (0.55, 0.09, 0.09, 1.0)),
    ("usb", (0.80, 0.80, 0.80, 1.0)),
    ("cap", (0.30, 0.30, 0.30, 1.0)),
    ("dip", (0.05, 0.05, 0.05, 1.0)),
    ("led", (0.85, 0.15, 0.10, 1.0)),
]

# ---------------------------------------------------------------------------
# GLB (glTF 2.0 binary) helpers
# ---------------------------------------------------------------------------


def read_glb(path: str):
    with open(path, "rb") as f:
        magic, version, length = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            raise ValueError(f"{path}: not a GLB (bad magic)")
        clen, ctype = struct.unpack("<II", f.read(8))
        gltf = json.loads(f.read(clen))
        blen, btype = struct.unpack("<II", f.read(8))
        binary = f.read(blen)
    return gltf, binary


def write_glb(path: str, gltf: dict, binary: bytes):
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(js) % 4:
        js += b" "
    while len(binary) % 4:
        binary += b"\x00"
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(binary), 0x004E4942))
        f.write(binary)


def accessor_data(gltf, binary, index: int) -> np.ndarray:
    a = gltf["accessors"][index]
    bv = gltf["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    comp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    fmt = {5126: "<f4", 5123: "<u2", 5125: "<u4"}[a["componentType"]]
    item = np.dtype(fmt).itemsize
    stride = bv.get("byteStride")
    if stride and stride != comp * item:
        rows = [
            np.frombuffer(binary, dtype=fmt, count=comp, offset=off + k * stride)
            for k in range(a["count"])
        ]
        return np.array(rows).astype(np.float64)
    raw = np.frombuffer(binary, dtype=fmt, count=a["count"] * comp, offset=off)
    return raw.reshape(a["count"], comp).astype(np.float64)


def node_local_matrix(node: dict) -> np.ndarray:
    m = np.eye(4)
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    if "translation" in node:
        t = np.eye(4)
        t[:3, 3] = node["translation"]
        m = m @ t
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        r = np.eye(4)
        r[:3, :3] = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ]
        )
        m = m @ r
    if "scale" in node:
        s = np.eye(4)
        s[0, 0], s[1, 1], s[2, 2] = node["scale"]
        m = m @ s
    return m


def world_matrices(gltf) -> dict[int, np.ndarray]:
    ws: dict[int, np.ndarray] = {}

    def walk(idx: int, parent: np.ndarray):
        node = gltf["nodes"][idx]
        world = parent @ node_local_matrix(node)
        ws[idx] = world
        for child in node.get("children", []):
            walk(child, world)

    for root in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        walk(root, np.eye(4))
    return ws


def mesh_triangles(gltf, binary, node: dict):
    for prim in gltf["meshes"][node["mesh"]]["primitives"]:
        pos = accessor_data(gltf, binary, prim["attributes"]["POSITION"])
        if "indices" in prim:
            idx = accessor_data(gltf, binary, prim["indices"]).astype(np.int64).ravel()
            yield pos[idx].astype(np.float64).reshape(-1, 3, 3)
        else:
            yield pos.astype(np.float64).reshape(-1, 3, 3)


def world_bounds(gltf, binary) -> tuple[np.ndarray, np.ndarray]:
    ws = world_matrices(gltf)
    mn = np.array([np.inf] * 3)
    mx = np.array([-np.inf] * 3)
    for idx, node in enumerate(gltf["nodes"]):
        if "mesh" not in node:
            continue
        w = ws[idx]
        for tri in mesh_triangles(gltf, binary, node):
            h = np.concatenate([tri, np.ones((*tri.shape[:2], 1))], axis=-1)
            ww = (w @ h.reshape(-1, 4).T).T[:, :3]
            mn = np.minimum(mn, ww.min(0))
            mx = np.maximum(mx, ww.max(0))
    return mn, mx


# ---------------------------------------------------------------------------
# glTF post-processing
# ---------------------------------------------------------------------------


def center_and_scale(gltf, binary):
    """Wrap the scene so 1 raw unit = 1 mm and bbox centre -> origin."""
    mn, mx = world_bounds(gltf, binary)
    center = (mn + mx) * 0.5
    s = 1000.0
    # new root: p' = 1000*(p - center)
    matrix = [
        s, 0.0, 0.0, 0.0,
        0.0, s, 0.0, 0.0,
        0.0, 0.0, s, 0.0,
        -center[0] * s, -center[1] * s, -center[2] * s, 1.0,
    ]
    old_root = gltf["scenes"][gltf.get("scene", 0)]["nodes"][0]
    model_index = len(gltf["nodes"])
    gltf["nodes"].append({"name": "model", "matrix": matrix, "children": [old_root]})
    gltf["scenes"][gltf.get("scene", 0)]["nodes"] = [model_index]
    return model_index


def add_pin_nodes(gltf, pins: dict[str, tuple[float, float, float]], parent: int):
    """Named empties under the scale wrapper (children of `parent`).

    No mesh => invisible anchors; positions in mm are stored in metres in the
    wrapper's local space (the wrapper applies the 1000x scale).
    """
    base = len(gltf["nodes"])
    for i, (name, (x, y, z)) in enumerate(sorted(pins.items())):
        gltf["nodes"].append(
            {"name": name, "translation": [x / 1000.0, y / 1000.0, z / 1000.0]}
        )
        gltf["nodes"][parent].setdefault("children", []).append(base + i)


def add_materials_by_name(gltf, hints):
    """One material per mesh node, chosen by the mesh name (Uno STEP has none)."""
    hints_sorted = sorted(hints, key=lambda h: -len(h[0]))
    gltf.setdefault("materials", list(gltf.get("materials", [])))
    for node in gltf["nodes"]:
        if "mesh" not in node:
            continue
        mesh = gltf["meshes"][node["mesh"]]
        name = (mesh.get("name") or "").lower()
        color = None
        for needle, c in hints_sorted:
            if needle in name:
                color = list(c)
                break
        if color is None:
            color = [0.62, 0.62, 0.62, 1.0]
        mat_index = len(gltf["materials"])
        gltf["materials"].append(
            {
                "name": f"auto_{name[:24] or mat_index}",
                "pbrMetallicRoughness": {"baseColorFactor": color},
                "doubleSided": True,
            }
        )
        for prim in mesh["primitives"]:
            prim["material"] = mat_index


def build_horn(gltf, ws, parent_world: np.ndarray):
    """Reparent the spinning servo parts under a named 'servo_horn' node.

    The group sits on the output shaft axis; members keep their world
    transforms by re-expressing them in the group's local space. Rotating
    the group about its local Y spins the whole assembly.
    """
    center_raw = np.array(SERVO_HORN["center_mm"], dtype=np.float64) / 1000.0
    horn_index = len(gltf["nodes"])
    gltf["nodes"].append({"name": SERVO_HORN["name"], "translation": center_raw.tolist()})

    scene_root = gltf["scenes"][gltf.get("scene", 0)]["nodes"][0]
    old_root = gltf["nodes"][scene_root]["children"][0]
    root_children = gltf["nodes"][old_root]["children"]

    members: list[int] = []
    for idx in list(root_children):
        node = gltf["nodes"][idx]
        if "mesh" not in node:
            continue
        name = (gltf["meshes"][node["mesh"]].get("name") or "")
        if any(s in name for s in SERVO_HORN["mesh_suffixes"]):
            members.append(idx)

    T = np.eye(4)
    T[:3, 3] = center_raw
    inv_parent = np.linalg.inv(parent_world)
    for idx in members:
        # horn world = parent_world @ T @ rel  =>  rel = inv(T) @ inv(parent_world) @ world
        rel = np.linalg.inv(T) @ inv_parent @ ws[idx]
        gltf["nodes"][idx].pop("translation", None)
        gltf["nodes"][idx].pop("rotation", None)
        gltf["nodes"][idx].pop("scale", None)
        gltf["nodes"][idx]["matrix"] = rel.T.flatten().tolist()
        root_children.remove(idx)
        gltf["nodes"][horn_index].setdefault("children", []).append(idx)

    root_children.append(horn_index)
    return members


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def manifest_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.json")


def update_manifest(key: str, out_path: str, pin_names: list[str]):
    path = manifest_path()
    manifest = {"version": 1, "models": {}}
    if os.path.exists(path):
        with open(path) as f:
            manifest = json.load(f)
    manifest.setdefault("version", 1)
    manifest.setdefault("models", {})
    rel = os.path.relpath(out_path, os.path.dirname(path)).replace(os.sep, "/")
    entry = manifest["models"].get(key)
    # Merge, don't clobber: keep the existing pinNodes order and bench values,
    # only appending contract pins that are missing.
    if isinstance(entry, dict):
        existing = [p for p in entry.get("pinNodes", []) if isinstance(p, str)]
        missing = [p for p in pin_names if p not in existing]
        pin_names = existing + missing
        bench = entry.get("bench") or {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1}
    else:
        bench = {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1}
    manifest["models"][key] = {
        "file": rel,
        "pinNodes": pin_names,
        "bench": bench,
    }
    # If the merged content is identical, leave the file byte-for-byte alone
    # (never reformat/clobber a manifest that is already correct).
    if json.load(open(path)) != manifest:
        with open(path, "w") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
            f.write("\n")
    else:
        print(f"  manifest unchanged")
    return rel


# ---------------------------------------------------------------------------
# Per-part conversion
# ---------------------------------------------------------------------------


def convert(step_path: str, out_path: str, key: str, spec: dict):
    if not os.path.exists(step_path):
        sys.exit(f"STEP/STL not found: {step_path}")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "raw.glb")
        if step_path.lower().endswith((".stl",)):
            # STL route (trimesh): the file is in mm, so pre-scale to the same
            # "metres == mm/1000" frame cascadio produces for STEP; the wrapper
            # below restores 1 raw unit = 1 mm. Axes pass through unchanged
            # (the DHT22 STL is already Y-up: pins +Y, grille +Z).
            try:
                import trimesh
            except ImportError:  # pragma: no cover - friendly error
                sys.exit(
                    "trimesh is required for STL sources.\\n"
                    "Install it with:  pip install -r requirements.txt"
                )
            mesh = trimesh.load(step_path, force="mesh")
            mesh.apply_scale(0.001)
            mesh.export(raw, file_type="glb")
        else:
            # native OpenCASCADE STEP -> glTF: no Blender, no FreeCAD, no Draco
            cascadio.step_to_glb(step_path, raw, include_materials=True)
        gltf, binary = read_glb(raw)

    mn, mx = world_bounds(gltf, binary)
    model_index = center_and_scale(gltf, binary)

    ws = world_matrices(gltf)  # recomputed after wrapping
    scene_root = gltf["scenes"][gltf.get("scene", 0)]["nodes"][0]
    old_root = gltf["nodes"][scene_root]["children"][0]

    if key == "servo":
        members = build_horn(gltf, ws, ws[old_root])
        print(f"  horn members reparented ({len(members)} meshes)")
    elif spec.get("materials"):
        add_materials_by_name(gltf, UNO_MATERIAL_HINTS)
        print(f"  added default materials ({len(gltf['materials'])} total)")

    # contract pins + aux anchors + spelling aliases (all named GLB nodes)
    pins = dict(spec["pins"])
    pins.update(spec.get("aux", {}))
    for alias, canon in spec.get("aliases", {}).items():
        pins[alias] = pins[canon]
    add_pin_nodes(gltf, pins, model_index)

    write_glb(out_path, gltf, binary)
    size_mm = (mx - mn) * 1000.0
    print(
        f"  wrote {out_path} ({os.path.getsize(out_path) / 1e6:.2f} MB, "
        f"bbox {size_mm[0]:.1f} x {size_mm[1]:.1f} x {size_mm[2]:.1f} mm, "
        f"{len(pins)} named pin nodes, Draco={bool(gltf.get('extensionsUsed'))})"
    )
    return list(spec["pins"].keys())


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_glb(path: str, expected: list[str]):
    gltf, binary = read_glb(path)
    names = [n.get("name") for n in gltf["nodes"] if n.get("name")]
    ext = gltf.get("extensionsUsed") or []
    mn, mx = world_bounds(gltf, binary)
    size = mx - mn  # wrapper already converts raw units -> mm
    missing = [p for p in expected if p not in names]
    print(f"[verify] {path}")
    print(f"  bbox: {size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} mm (centre offset: "
          f"{((mn + mx) * 0.5).round(4)})")
    print(f"  extensionsUsed: {ext or 'none -> Draco OFF'}")
    print(f"  contract pins present: {len(expected) - len(missing)}/{len(expected)}")
    if missing:
        print(f"  MISSING: {missing}")
        return False
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

PART_SPECS = {
    "arduino-uno": {
        "step": "cad/arduino_uno/arduino uno.STEP",
        "out": ("external/velxio/frontend/public/models3d/"
                "arduino-uno/arduino-uno.glb"),
        "pins": UNO_PINS,
        "aux": UNO_AUX_PINS,
        "aliases": UNO_ALIASES,
        "materials": True,
    },
    "servo": {
        "step": ("cad/sg90-micro-servo-9g-tower-pro-1.snapshot.3/"
                 "SG90 - Micro Servo 9g - Tower Pro.STEP"),
        "out": "external/velxio/frontend/public/models3d/sg90/sg90.glb",
        "pins": SERVO_PINS,
        "aux": {},
        "aliases": SERVO_ALIASES,
        "materials": False,
    },
    "dht22": {
        "step": "cad/dht22/dht22.stl",
        "out": ("external/velxio/frontend/public/models3d/"
                "dht22/dht22.glb"),
        # CONTRACT pins (names MUST equal the element's pinInfo:
        # VCC, SDA, NC, GND — see wokwi-elements dht22-element.ts)
        "pins": DHT22_PINS,
        "aux": {},        # extra anchors (non-contract) if the part needs them
        "aliases": {},    # e.g. {"PWM": "SIGNAL"}
        "materials": False,   # STL carries no material info
        "horn": None,         # no rotating assembly on a DHT22
    },
}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(here, "..", "..", "..", "..", ".."))
    os.chdir(repo_root)

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true", help="build both parts + manifest")
    ap.add_argument("--step", help="single STEP file to convert")
    ap.add_argument("--out", help="output .glb path (with --step)")
    ap.add_argument("--key", choices=sorted(PART_SPECS), help="manifest key")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()

    if args.step or args.out:
        if not (args.step and args.out and args.key):
            ap.error("--step/--out/--key must be used together")
        spec = PART_SPECS[args.key]
        print(f"[build] {args.key} <- {args.step}")
        names = convert(args.step, args.out, args.key, spec)
        update_manifest(args.key, args.out, names)
        print(f"[manifest] updated {manifest_path()}")
    else:
        for key, spec in PART_SPECS.items():
            print(f"[build] {key} <- {spec['step']}")
            names = convert(spec["step"], spec["out"], key, spec)
            update_manifest(key, spec["out"], names)
        print(f"[manifest] updated {manifest_path()}")

    if not args.no_verify:
        ok = True
        for key, spec in PART_SPECS.items():
            out = spec["out"]
            if not os.path.exists(out):
                if args.step and args.out == out:
                    continue
                print(f"[verify] SKIP missing {out}")
                continue
            ok &= verify_glb(out, list(spec["pins"].keys()))
        if not ok:
            sys.exit("VERIFICATION FAILED - pin names did not round-trip")
        print("[verify] OK - all contract pin names round-tripped, Draco off")

    print("Done. Restart the dev server, open the 3D view.")


if __name__ == "__main__":
    main()
