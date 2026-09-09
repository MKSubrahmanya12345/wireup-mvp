#!/usr/bin/env python3
"""Build a reviewable, Three.js-ready GLB from one known STEP assembly.

This is intentionally an offline/CI asset job. It is not imported by Next.js
routes and it never tries to invent a PCB layout from a text component spec.

Pipeline:
  STEP (or a verified KiCad package 3D model) -> cascadio/OpenCASCADE -> GLB
  -> normalised millimetre root + named pin anchors + material pass -> validate

Usage:
  python tools/cad/build_glb.py --asset tools/cad/asset-manifest.example.json

Requires:
  python -m pip install -r tools/cad/requirements.txt
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any


def require_cascadio():
    """Import the optional build dependency only when a build is requested."""
    try:
        import cascadio
    except ImportError as error:  # pragma: no cover - user-facing dependency message
        raise RuntimeError(
            "cascadio is required for the STEP -> GLB build.\n"
            "Install the isolated CAD dependencies with:\n"
            "  python -m pip install -r tools/cad/requirements.txt"
        ) from error
    return cascadio

GLB_MAGIC = 0x46546C67
GLB_JSON = 0x4E4F534A
GLB_BIN = 0x004E4942

# Conservative defaults. Per-asset rules can override all three values.
DEFAULT_MATERIALS: list[dict[str, Any]] = [
    {"match": "board", "color": "#0d4f96", "metallic": 0.12, "roughness": 0.36},
    {"match": "pcb", "color": "#0d4f96", "metallic": 0.12, "roughness": 0.36},
    {"match": "header", "color": "#181b22", "metallic": 0.10, "roughness": 0.40},
    {"match": "pin", "color": "#d8b560", "metallic": 0.90, "roughness": 0.18},
    {"match": "usb", "color": "#c8ced8", "metallic": 0.82, "roughness": 0.23},
    {"match": "crystal", "color": "#bbc1c6", "metallic": 0.78, "roughness": 0.24},
    {"match": "jack", "color": "#13161d", "metallic": 0.08, "roughness": 0.38},
    {"match": "chip", "color": "#13161a", "metallic": 0.10, "roughness": 0.42},
    {"match": "dip", "color": "#13161a", "metallic": 0.10, "roughness": 0.42},
    {"match": "led", "color": "#d33b35", "metallic": 0.04, "roughness": 0.24, "emissive": "#280504"},
]
DEFAULT_FALLBACK = {"color": "#9aa4b1", "metallic": 0.32, "roughness": 0.40}


def read_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    with path.open("rb") as handle:
        header = handle.read(12)
        if len(header) != 12:
            raise ValueError(f"{path}: incomplete GLB header")
        magic, version, _length = struct.unpack("<III", header)
        if magic != GLB_MAGIC or version != 2:
            raise ValueError(f"{path}: expected a glTF 2.0 binary file")
        json_length, json_type = struct.unpack("<II", handle.read(8))
        if json_type != GLB_JSON:
            raise ValueError(f"{path}: JSON chunk is missing")
        gltf = json.loads(handle.read(json_length).decode("utf-8"))
        bin_header = handle.read(8)
        if not bin_header:
            return gltf, b""
        binary_length, binary_type = struct.unpack("<II", bin_header)
        if binary_type != GLB_BIN:
            raise ValueError(f"{path}: binary chunk is missing")
        return gltf, handle.read(binary_length)


def write_glb(path: Path, gltf: dict[str, Any], binary: bytes) -> None:
    json_bytes = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    binary += b"\0" * (-len(binary) % 4)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(struct.pack("<III", GLB_MAGIC, 2, 12 + 8 + len(json_bytes) + 8 + len(binary)))
        handle.write(struct.pack("<II", len(json_bytes), GLB_JSON))
        handle.write(json_bytes)
        handle.write(struct.pack("<II", len(binary), GLB_BIN))
        handle.write(binary)


def hex_to_factor(value: str) -> list[float]:
    clean = value.strip().lstrip("#")
    if len(clean) == 3:
        clean = "".join(character * 2 for character in clean)
    if len(clean) != 6:
        raise ValueError(f"Expected a #RRGGBB colour, got {value!r}")
    return [int(clean[index:index + 2], 16) / 255 for index in (0, 2, 4)] + [1.0]


def resolve_path(value: str, manifest_path: Path) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else (manifest_path.parent / candidate).resolve()


def normalise_anchor(raw: dict[str, Any]) -> tuple[str, list[float]]:
    name = raw.get("name")
    position = raw.get("positionMm")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Each pinAnchors entry needs a non-empty name")
    if not isinstance(position, list) or len(position) != 3 or not all(isinstance(value, (int, float)) for value in position):
        raise ValueError(f"Anchor {name!r} needs positionMm: [x, y, z]")
    # Source geometry leaves cascadio in metres. Its new parent multiplies all
    # child positions by 1000, so mm anchor coordinates must be stored in m.
    return name, [float(value) / 1000 for value in position]


def add_millimetre_root_and_anchors(gltf: dict[str, Any], anchors: list[tuple[str, list[float]]]) -> None:
    scenes = gltf.setdefault("scenes", [{"nodes": []}])
    scene_index = int(gltf.get("scene", 0))
    if scene_index < 0 or scene_index >= len(scenes):
        raise ValueError("The source GLB points to an invalid scene")
    scene = scenes[scene_index]
    old_roots = list(scene.get("nodes", []))
    nodes: list[dict[str, Any]] = gltf.setdefault("nodes", [])
    root_index = len(nodes)
    root: dict[str, Any] = {
        "name": "wireup_model_mm",
        "scale": [1000.0, 1000.0, 1000.0],
        "children": old_roots,
    }
    nodes.append(root)
    for name, position_metres in anchors:
        anchor_index = len(nodes)
        nodes.append({"name": name, "translation": position_metres})
        root["children"].append(anchor_index)
    scene["nodes"] = [root_index]


def choose_material(mesh_name: str, hints: list[dict[str, Any]]) -> dict[str, Any]:
    lower_name = mesh_name.lower()
    for hint in sorted(hints, key=lambda item: len(str(item.get("match", ""))), reverse=True):
        match = str(hint.get("match", "")).lower()
        if match and match in lower_name:
            return hint
    return DEFAULT_FALLBACK


def apply_material_pass(gltf: dict[str, Any], hints: list[dict[str, Any]]) -> None:
    """Assign simple PBR materials by reviewed mesh-name rules.

    STEP often has no portable material information. The pass is intentionally
    explicit and audit-friendly: a material derives only from a named rule in
    the asset manifest, never from an unreviewed LLM guess.
    """
    meshes = gltf.get("meshes", [])
    materials: list[dict[str, Any]] = gltf.setdefault("materials", [])
    for mesh_index, mesh in enumerate(meshes):
        rule = choose_material(str(mesh.get("name") or f"mesh-{mesh_index}"), hints)
        pbr = {
            "baseColorFactor": hex_to_factor(str(rule.get("color", DEFAULT_FALLBACK["color"]))),
            "metallicFactor": float(rule.get("metallic", DEFAULT_FALLBACK["metallic"])),
            "roughnessFactor": float(rule.get("roughness", DEFAULT_FALLBACK["roughness"])),
        }
        material: dict[str, Any] = {
            "name": f"wireup_{str(mesh.get('name') or mesh_index)[:48]}",
            "pbrMetallicRoughness": pbr,
            "doubleSided": True,
        }
        if rule.get("emissive"):
            material["emissiveFactor"] = hex_to_factor(str(rule["emissive"]))[:3]
        material_index = len(materials)
        materials.append(material)
        for primitive in mesh.get("primitives", []):
            primitive["material"] = material_index


def validate_gltf(gltf: dict[str, Any], output_path: Path, expected_anchors: list[str], max_bytes: int) -> None:
    names = [node.get("name") for node in gltf.get("nodes", []) if isinstance(node.get("name"), str)]
    missing = [name for name in expected_anchors if name not in names]
    if missing:
        raise ValueError(f"Missing named pin anchors: {', '.join(missing)}")
    if "wireup_model_mm" not in names:
        raise ValueError("GLB does not contain the normalised wireup_model_mm root")
    if not gltf.get("meshes"):
        raise ValueError("GLB has no meshes")
    if not gltf.get("materials"):
        raise ValueError("GLB material pass did not produce any materials")
    size = output_path.stat().st_size
    if size > max_bytes:
        raise ValueError(f"GLB is {size / 1_000_000:.2f} MB; limit is {max_bytes / 1_000_000:.2f} MB")


def build(asset_manifest_path: Path) -> None:
    manifest = json.loads(asset_manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Asset manifest must be a JSON object")

    asset_id = manifest.get("id")
    source_value = manifest.get("source")
    output_value = manifest.get("output")
    if not isinstance(asset_id, str) or not asset_id:
        raise ValueError("Asset manifest needs an id")
    if not isinstance(source_value, str) or not isinstance(output_value, str):
        raise ValueError("Asset manifest needs source and output paths")

    source = resolve_path(source_value, asset_manifest_path)
    output = resolve_path(output_value, asset_manifest_path)
    if source.suffix.lower() not in {".step", ".stp"}:
        raise ValueError("Only STEP/STP is accepted here. Convert a source package explicitly before this stage.")
    if not source.exists():
        raise FileNotFoundError(f"STEP source not found: {source}")

    raw_anchors = manifest.get("pinAnchors", [])
    if not isinstance(raw_anchors, list):
        raise ValueError("pinAnchors must be an array")
    anchors = [normalise_anchor(anchor) for anchor in raw_anchors]
    names = [name for name, _ in anchors]
    if len(names) != len(set(names)):
        raise ValueError("pinAnchors contains duplicate names")

    custom_hints = manifest.get("materialHints", [])
    if not isinstance(custom_hints, list):
        raise ValueError("materialHints must be an array")
    hints = [*custom_hints, *DEFAULT_MATERIALS]
    max_bytes = int(manifest.get("maxBytes", 15_000_000))

    with tempfile.TemporaryDirectory(prefix="wireup-cad-") as temporary:
        raw_glb = Path(temporary) / "source.glb"
        # OpenCASCADE reads STEP directly; Blender and a GUI are not involved.
        cascadio = require_cascadio()
        cascadio.step_to_glb(str(source), str(raw_glb), include_materials=True)
        gltf, binary = read_glb(raw_glb)

    add_millimetre_root_and_anchors(gltf, anchors)
    apply_material_pass(gltf, hints)
    write_glb(output, gltf, binary)
    validate_gltf(gltf, output, names, max_bytes)

    print(f"[cad] built {asset_id}")
    print(f"[cad] output: {output}")
    print(f"[cad] meshes/materials: {len(gltf.get('meshes', []))}/{len(gltf.get('materials', []))}")
    print(f"[cad] named anchors: {len(names)}")
    print(f"[cad] size: {output.stat().st_size / 1_000_000:.2f} MB")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a reviewed STEP CAD asset for the Wireup WebGL studio")
    parser.add_argument("--asset", type=Path, required=True, help="Path to a Wireup CAD asset manifest JSON")
    arguments = parser.parse_args()
    try:
        build(arguments.asset.resolve())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
