'use client';

/**
 * src/components/admin/CadPreviewCanvas.tsx
 * Real-time interactive Three.js WebGL canvas for previewing 3D CAD models,
 * substrate geometries, surface features, and named pin anchor nodes in 3D space.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CadComponentSpec } from 'cad-helper';

interface CadPreviewCanvasProps {
  spec: CadComponentSpec;
  showPins?: boolean;
  wireframe?: boolean;
}

export function CadPreviewCanvas({ spec, showPins = true, wireframe = false }: CadPreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const isDraggingRef = useRef(false);
  const previousMousePosition = useRef({ x: 0, y: 0 });

  const [activePin, setActivePin] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 1. Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f172a'); // Slate dark background
    sceneRef.current = scene;

    // 2. Camera Setup
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 400;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(40, 35, 50);
    camera.lookAt(0, 5, 0);
    cameraRef.current = camera;

    // 3. Renderer Setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.replaceChildren(renderer.domElement);
    rendererRef.current = renderer;

    // 4. Lighting Setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight1.position.set(40, 60, 40);
    dirLight1.castShadow = true;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x93c5fd, 0.6);
    dirLight2.position.set(-40, -20, -30);
    scene.add(dirLight2);

    // 5. Grid Floor
    const grid = new THREE.GridHelper(80, 40, 0x3b82f6, 0x1e293b);
    grid.position.y = -0.05;
    scene.add(grid);

    // 6. Model Group
    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    modelGroupRef.current = modelGroup;

    // 7. Mouse Orbit Drag Handling
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0 || e.button === 2) {
        isDraggingRef.current = true;
        previousMousePosition.current = { x: e.clientX, y: e.clientY };
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !modelGroupRef.current) return;
      const deltaX = e.clientX - previousMousePosition.current.x;
      const deltaY = e.clientY - previousMousePosition.current.y;

      if (e.buttons === 1) {
        // Left click: Orbit rotate model
        modelGroupRef.current.rotation.y += deltaX * 0.01;
        modelGroupRef.current.rotation.x += deltaY * 0.01;
      } else if (e.buttons === 2) {
        // Right click: Pan camera
        camera.position.x -= deltaX * 0.05;
        camera.position.y += deltaY * 0.05;
      }

      previousMousePosition.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 1.08 : 0.92;
      camera.position.multiplyScalar(zoomFactor);
      camera.position.clampLength(10, 200);
    };

    const domEl = renderer.domElement;
    domEl.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    domEl.addEventListener('wheel', onWheel, { passive: false });
    domEl.addEventListener('contextmenu', (e) => e.preventDefault());

    // 8. Resize Observer
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObserver.observe(container);

    // 9. Animation Loop
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animationFrameId);
      domEl.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      domEl.removeEventListener('wheel', onWheel);
      resizeObserver.disconnect();
      renderer.dispose();
    };
  }, []);

  // Re-build 3D Meshes whenever spec changes
  useEffect(() => {
    const group = modelGroupRef.current;
    if (!group) return;

    // Clear old children
    while (group.children.length > 0) {
      const obj = group.children[0];
      group.remove(obj);
    }

    const { widthMm, lengthMm, heightMm } = spec.dimensions;

    // 1. PCB Substrate Mesh
    const pcbGeo = new THREE.BoxGeometry(widthMm, heightMm, lengthMm);
    const pcbMat = new THREE.MeshStandardMaterial({
      color: spec.bodyColor || '#1a5b8c',
      roughness: 0.5,
      metalness: 0.1,
      wireframe,
    });
    const pcbMesh = new THREE.Mesh(pcbGeo, pcbMat);
    pcbMesh.position.set(0, heightMm / 2, 0);
    pcbMesh.castShadow = true;
    pcbMesh.receiveShadow = true;
    group.add(pcbMesh);

    // 2. Pins & Headers
    const pinMetalMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b, // Gold/Brass
      metalness: 0.9,
      roughness: 0.2,
      wireframe,
    });

    const collarMat = new THREE.MeshStandardMaterial({
      color: 0x18181b, // Black plastic
      roughness: 0.8,
      wireframe,
    });

    for (const pin of spec.pins) {
      const pinLength = 6.0;
      const pinGeo = new THREE.BoxGeometry(0.64, pinLength, 0.64);
      const pinMesh = new THREE.Mesh(pinGeo, pinMetalMat);
      const pinCy = pin.direction === 'down' ? -(pinLength / 2) : heightMm + pinLength / 2;
      pinMesh.position.set(pin.xMm, pinCy, pin.zMm);
      group.add(pinMesh);

      const collarGeo = new THREE.BoxGeometry(2.4, 2.0, 2.4);
      const collarMesh = new THREE.Mesh(collarGeo, collarMat);
      const collarCy = pin.direction === 'down' ? -1.0 : heightMm + 1.0;
      collarMesh.position.set(pin.xMm, collarCy, pin.zMm);
      group.add(collarMesh);

      // Injected Named Pin Anchor Node (Empty)
      const pinAnchor = new THREE.Object3D();
      pinAnchor.name = pin.name;
      pinAnchor.position.set(pin.xMm, pin.yMm, pin.zMm);
      group.add(pinAnchor);

      // 3D Pin Visual Marker
      if (showPins) {
        const markerGeo = new THREE.SphereGeometry(0.7, 12, 12);
        const markerMat = new THREE.MeshBasicMaterial({
          color: pin.role === 'power' ? 0xef4444 : pin.role === 'ground' ? 0x10b981 : 0x3b82f6,
        });
        const markerMesh = new THREE.Mesh(markerGeo, markerMat);
        markerMesh.position.set(pin.xMm, pin.yMm, pin.zMm);
        group.add(markerMesh);
      }
    }

    // 3. Surface Features
    for (const feat of spec.features) {
      const [fx, fy, fz] = feat.position;
      const [d1, d2, d3] = feat.dimensions;
      const featColor = feat.color || '#94a3b8';

      const featMat = new THREE.MeshStandardMaterial({
        color: featColor,
        roughness: feat.type === 'heatsink' ? 0.3 : feat.type === 'screen' ? 0.1 : 0.6,
        metalness: feat.type === 'heatsink' ? 0.8 : 0.1,
        wireframe,
      });

      let featMesh: THREE.Mesh;
      if (feat.type === 'cylinder' || feat.type === 'lens') {
        const cylGeo = new THREE.CylinderGeometry(d1, d1, d2, 24);
        featMesh = new THREE.Mesh(cylGeo, featMat);
      } else {
        const boxGeo = new THREE.BoxGeometry(d1, d2, d3);
        featMesh = new THREE.Mesh(boxGeo, featMat);
      }

      featMesh.position.set(fx, fy, fz);
      featMesh.castShadow = true;
      group.add(featMesh);
    }
  }, [spec, showPins, wireframe]);

  const resetCamera = () => {
    if (cameraRef.current && modelGroupRef.current) {
      cameraRef.current.position.set(40, 35, 50);
      cameraRef.current.lookAt(0, 5, 0);
      modelGroupRef.current.rotation.set(0, 0, 0);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '420px', borderRadius: '8px', overflow: 'hidden', border: '1px solid #334155', background: '#090d16' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Floating Viewport Controls */}
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 6, zIndex: 10 }}>
        <button
          type="button"
          className="btn btn--sm"
          onClick={resetCamera}
          style={{ background: '#1e293b', color: '#f8fafc', border: '1px solid #475569', fontSize: 11 }}
        >
          Reset View
        </button>
      </div>

      <div style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(15, 23, 42, 0.85)', padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', color: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }}>
        <span>{spec.dimensions.widthMm} × {spec.dimensions.lengthMm} × {spec.dimensions.heightMm} mm</span>
        <span style={{ margin: '0 8px', opacity: 0.4 }}>|</span>
        <span style={{ color: '#38bdf8' }}>{spec.pins.length} Pins</span>
      </div>

      {/* Pin list chips at bottom */}
      <div style={{ position: 'absolute', bottom: 10, left: 10, right: 10, display: 'flex', flexWrap: 'wrap', gap: 6, zIndex: 10, pointerEvents: 'none' }}>
        {spec.pins.map((pin) => (
          <span
            key={pin.name}
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '11px',
              fontFamily: 'monospace',
              fontWeight: 600,
              background: pin.role === 'power' ? 'rgba(239, 68, 68, 0.8)' : pin.role === 'ground' ? 'rgba(16, 185, 129, 0.8)' : 'rgba(59, 130, 246, 0.8)',
              color: '#ffffff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
            }}
          >
            {pin.name} ({pin.xMm}, {pin.yMm}, {pin.zMm})
          </span>
        ))}
      </div>
    </div>
  );
}
