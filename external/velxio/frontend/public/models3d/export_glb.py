#!/usr/bin/env python3
"""
export_glb.py — convert a CAD part into the GLB the 3D view needs.

Blender 5.x has NO native STEP importer, so this script takes an **STL** mesh
(convert your .STEP -> .stl in FreeCAD or CAD Assistant once) and produces the
GLB with the named pin empties.
"""

import argparse
import json
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    p = argparse.ArgumentParser(description="Export a CAD part to a GLB for the 3D view.")
    p.add_argument("--input", "--step", dest="input_path", required=True,
                   help=".stl (or .step/.stp if your Blender has a STEP importer).")
    p.add_argument("--out", required=True, help="Output .glb path.")
    p.add_argument("--key", required=True, help="Manifest key (boardKind / metadataId).")
    p.add_argument("--pins-json", default=None,
                   help="JSON file: [{'name': 'D0', 'x': 0, 'y': 0, 'z': 0}, ...] in local mm.")
    p.add_argument("--pins", nargs="*", default=None,
                   help="Space-separated name:x:y:z entries (e.g. SIGNAL:5:0:0 VCC:0:5:0).")
    p.add_argument("--manifest", required=True, help="Path to /models3d/manifest.json.")
    return p.parse_args(argv)


def set_scene_mm():
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.length_unit = "MILLIMETERS"
    bpy.context.scene.unit_settings.scale_length = 1.0


def import_mesh(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".step", ".stp"):
        bpy.ops.import_scene.import_step(filepath=path)
    else:
        bpy.ops.import_mesh.stl(filepath=path)


def add_empty(name, co):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=co)
    ob = bpy.context.object
    ob.name = name
    return ob


def center_scene_at_origin():
    from mathutils import Vector
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not objs:
        return
    minv = Vector((float("inf"),) * 3)
    maxv = Vector((float("-inf"),) * 3)
    for o in objs:
        for corner in o.bound_box:
            wc = o.matrix_world @ Vector(corner)
            minv.x = min(minv.x, wc.x)
            minv.y = min(minv.y, wc.y)
            minv.z = min(minv.z, wc.z)
            maxv.x = max(maxv.x, wc.x)
            maxv.y = max(maxv.y, wc.y)
            maxv.z = max(maxv.z, wc.z)
    center = (minv + maxv) * 0.5
    for o in bpy.context.scene.objects:
        o.location -= center
    bpy.context.view_layer.update()


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    set_scene_mm()
    args = parse_args()

    if not os.path.exists(args.input_path):
        raise SystemExit(f"Input not found: {args.input_path}")

    import_mesh(args.input_path)

    pins = []
    if args.pins_json:
        with open(args.pins_json) as f:
            pins = json.load(f)
    elif args.pins:
        for entry in args.pins:
            name, x, y, z = (entry.split(":") + ["0", "0", "0"])[:4]
            pins.append({"name": name, "x": float(x), "y": float(y), "z": float(z)})

    center_scene_at_origin()
    for p in pins:
        add_empty(p["name"], (p["x"], p["y"], p["z"]))
        bpy.context.object.hide_render = True

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=args.out,
        export_format="GLB",
        export_draco_mesh_compression_enable=False,
        export_yup=True,
    )

    manifest_path = args.manifest
    manifest = {"version": 1, "models": {}}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    pin_names = [p["name"] for p in pins]
    manifest.setdefault("models", {})[args.key] = {
        "file": os.path.relpath(args.out, os.path.dirname(manifest_path)).replace(os.sep, "/"),
        "pinNodes": pin_names,
        "bench": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1},
    }
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[export_glb] wrote {args.out}; manifest key '{args.key}' ({len(pin_names)} pins)")


if __name__ == "__main__":
    main()

