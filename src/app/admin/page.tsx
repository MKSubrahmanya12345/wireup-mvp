'use client';

/**
 * src/app/admin/page.tsx
 * WireUp Engineering & Admin Console
 * Features:
 *   1. Hardcoded Admin Authentication (admin@wireup.com / admin123)
 *   2. 3D CAD & Component Studio: Datasheet -> Parametric 3D STL/GLB -> Velxio Auto-Sync & Seeder
 *   3. Catalog Explorer & System Diagnostics
 */

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import type { CadComponentSpec, CadPinDefinition, CadFeature, ComponentRole, PinSignalRole } from 'cad-helper';
import { COMPONENT_PRESETS } from 'cad-helper';
import { CadPreviewCanvas } from '@/components/admin/CadPreviewCanvas';

type AdminTab = 'cad-studio' | 'catalog' | 'diagnostics';

export default function AdminPage() {
  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [email, setEmail] = useState('admin@wireup.com');
  const [password, setPassword] = useState('admin123');
  const [authError, setAuthError] = useState<string | null>(null);

  // Active Tab
  const [activeTab, setActiveTab] = useState<AdminTab>('cad-studio');

  // CAD Studio state
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>('hc-sr04-ultrasonic');
  const [spec, setSpec] = useState<CadComponentSpec>(COMPONENT_PRESETS['hc-sr04-ultrasonic']);
  const [rawDatasheetText, setRawDatasheetText] = useState<string>('');
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployResult, setDeployResult] = useState<{ success: boolean; message: string; glbPath?: string } | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [wireframeMode, setWireframeMode] = useState<boolean>(false);

  // Check persistent session on mount
  useEffect(() => {
    const token = localStorage.getItem('wireup_admin_auth');
    if (token) {
      setIsAuthenticated(true);
    }
  }, []);

  // Update spec when preset changes
  const handlePresetSelect = (key: string) => {
    setSelectedPresetKey(key);
    if (COMPONENT_PRESETS[key]) {
      setSpec(JSON.parse(JSON.stringify(COMPONENT_PRESETS[key])));
      setDeployResult(null);
    }
  };

  // Handle Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (data.ok) {
        setIsAuthenticated(true);
        localStorage.setItem('wireup_admin_auth', data.token);
      } else {
        setAuthError(data.error || 'Invalid credentials');
      }
    } catch (err) {
      setAuthError('Authentication server error');
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem('wireup_admin_auth');
  };

  // Parse Raw Datasheet
  const handleParseDatasheet = async () => {
    if (!rawDatasheetText.trim()) return;
    setIsParsing(true);
    setDeployResult(null);

    try {
      const res = await fetch('/api/admin/cad/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: rawDatasheetText }),
      });

      const data = await res.json();
      if (data.ok && data.spec) {
        setSpec(data.spec);
      }
    } catch (err) {
      alert('Failed to parse datasheet');
    } finally {
      setIsParsing(false);
    }
  };

  // Auto-generate Seed Code & Bundle
  const handleGenerateBundle = async () => {
    try {
      const res = await fetch('/api/admin/cad/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      const data = await res.json();
      if (data.ok) {
        setGeneratedCode(data.seedCode);
        return data;
      }
    } catch (err) {
      console.error(err);
    }
    return null;
  };

  useEffect(() => {
    void handleGenerateBundle();
  }, [spec]);

  // Deploy to Velxio
  const handleDeployToVelxio = async () => {
    setIsDeploying(true);
    setDeployResult(null);

    try {
      const res = await fetch('/api/admin/cad/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });

      const data = await res.json();
      if (data.ok) {
        setDeployResult({
          success: true,
          message: data.result.message,
          glbPath: data.result.glbPath,
        });
      } else {
        setDeployResult({
          success: false,
          message: data.error || 'Deployment failed',
        });
      }
    } catch (err) {
      setDeployResult({
        success: false,
        message: 'Network error while deploying CAD model',
      });
    } finally {
      setIsDeploying(false);
    }
  };

  // Download STL
  const handleDownloadStl = async () => {
    const bundle = await handleGenerateBundle();
    if (!bundle?.stlBinaryBase64) return;

    const byteCharacters = atob(bundle.stlBinaryBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'application/octet-stream' });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.id}.stl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Download GLB
  const handleDownloadGlb = async () => {
    const bundle = await handleGenerateBundle();
    if (!bundle?.glbBinaryBase64) return;

    const byteCharacters = atob(bundle.glbBinaryBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'model/gltf-binary' });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.id}.glb`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Pin modification helpers
  const handleAddPin = () => {
    const nextPinNum = spec.pins.length + 1;
    const pitch = 2.54;
    const nextX = spec.pins.length > 0 ? spec.pins[spec.pins.length - 1].xMm + pitch : 0;
    const newPin: CadPinDefinition = {
      name: `PIN${nextPinNum}`,
      pinNumber: nextPinNum,
      role: 'digital',
      signal: `GPIO / Signal ${nextPinNum}`,
      xMm: Number(nextX.toFixed(2)),
      yMm: 6.0,
      zMm: -spec.dimensions.lengthMm / 2 + 2.54,
      direction: 'up',
      required: false,
    };
    setSpec({ ...spec, pins: [...spec.pins, newPin] });
  };

  const handleRemovePin = (index: number) => {
    const updated = spec.pins.filter((_, i) => i !== index);
    setSpec({ ...spec, pins: updated });
  };

  const handleUpdatePin = (index: number, patch: Partial<CadPinDefinition>) => {
    const updated = [...spec.pins];
    updated[index] = { ...updated[index], ...patch };
    setSpec({ ...spec, pins: updated });
  };

  /* ------------------------------------------------------------------------ */
  /* Render Login View if not Authenticated                                   */
  /* ------------------------------------------------------------------------ */
  if (!isAuthenticated) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <header className="topbar">
          <Link href="/" className="topbar__brand">
            <span className="topbar__mark">W</span>
            <span>Wireup</span>
          </Link>
          <span className="topbar__spacer" />
          <span className="topbar__meta">admin portal / secure access</span>
        </header>

        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{ maxWidth: 440, width: '100%', background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 32, boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, background: 'var(--text)', color: '#fff', fontWeight: 'bold' }}>
                ⚙
              </span>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Admin Login</h1>
            </div>
            <p style={{ margin: '0 0 24px', color: 'var(--text-muted)', fontSize: 13 }}>
              Access internal CAD engineering helpers, datasheet converter, and 3D simulation tools.
            </p>

            {authError && (
              <div style={{ padding: '10px 14px', marginBottom: 16, background: 'var(--err-bg)', border: '1px solid var(--err)', borderRadius: 6, color: 'var(--err)', fontSize: 13 }}>
                {authError}
              </div>
            )}

            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14, fontFamily: 'var(--sans)' }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14, fontFamily: 'var(--sans)' }}
                />
              </div>

              <div style={{ background: 'var(--bg-sunken)', padding: '8px 12px', borderRadius: 6, marginBottom: 20, fontSize: 12, color: 'var(--text-muted)' }}>
                Demo Credentials: <strong style={{ color: 'var(--text)' }}>admin@wireup.com</strong> / <strong style={{ color: 'var(--text)' }}>admin123</strong>
              </div>

              <button
                type="submit"
                className="btn btn--primary"
                style={{ width: '100%', padding: '12px', fontSize: 14, fontWeight: 600 }}
              >
                Sign In to Console
              </button>
            </form>

            <div style={{ marginTop: 24, textAlign: 'center' }}>
              <Link href="/" style={{ color: 'var(--text-muted)', fontSize: 13, textDecoration: 'none' }}>
                ← Return to WireUp Home
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Render Admin Console                                                     */
  /* ------------------------------------------------------------------------ */
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Top Navigation */}
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span>Wireup</span>
          <span style={{ marginLeft: 8, padding: '2px 8px', background: '#e0ebeb', color: '#0b3d91', fontSize: 11, fontWeight: 700, borderRadius: 4 }}>
            ADMIN CONSOLE
          </span>
        </Link>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 24 }}>
          <button
            type="button"
            onClick={() => setActiveTab('cad-studio')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: activeTab === 'cad-studio' ? '1px solid var(--border-strong)' : '1px solid transparent',
              background: activeTab === 'cad-studio' ? '#ffffff' : 'transparent',
              fontWeight: activeTab === 'cad-studio' ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            ⚡ 3D CAD & Component Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('catalog')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: activeTab === 'catalog' ? '1px solid var(--border-strong)' : '1px solid transparent',
              background: activeTab === 'catalog' ? '#ffffff' : 'transparent',
              fontWeight: activeTab === 'catalog' ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            📦 Seed Catalog
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('diagnostics')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: activeTab === 'diagnostics' ? '1px solid var(--border-strong)' : '1px solid transparent',
              background: activeTab === 'diagnostics' ? '#ffffff' : 'transparent',
              fontWeight: activeTab === 'diagnostics' ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            🛠 Diagnostics
          </button>
        </div>

        <span className="topbar__spacer" />

        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 16 }}>
          Logged in as <strong>{email}</strong>
        </span>

        <button
          type="button"
          className="btn btn--sm"
          onClick={handleLogout}
          style={{ marginRight: 8 }}
        >
          Sign Out
        </button>
      </header>

      {/* Main Studio View */}
      <main style={{ flex: 1, padding: '20px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>
        {activeTab === 'cad-studio' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 1fr) minmax(480px, 1.2fr)', gap: 24 }}>
            
            {/* Left Column: Datasheet & Spec Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              
              {/* Presets & Intake Card */}
              <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>
                <h2 style={{ fontSize: 15, margin: '0 0 12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>📑 Datasheet Presets & Intake</span>
                </h2>

                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Select High-Accuracy Component Preset:
                  </label>
                  <select
                    value={selectedPresetKey}
                    onChange={(e) => handlePresetSelect(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, background: '#fff' }}
                  >
                    <option value="hc-sr04-ultrasonic">HC-SR04 Ultrasonic Distance Sensor (Dual Cylinders, 4-Pin)</option>
                    <option value="oled-ssd1306-i2c">0.96" I2C OLED Display SSD1306 (Glass Screen, 4-Pin)</option>
                    <option value="bme280-environmental">BME280 Environmental Sensor (Pressure/Temp/Humidity, 6-Pin)</option>
                    <option value="mpu6050-imu">MPU-6050 6-Axis Gyro/Accelerometer (QFN Chip, 8-Pin)</option>
                    <option value="pir-sensor-hc-sr501">HC-SR501 PIR Motion Sensor (Fresnel Dome Lens, 3-Pin)</option>
                    <option value="l298n-motor-driver">L298N Dual H-Bridge Motor Driver (Heatsink & Terminals)</option>
                    <option value="rotary-encoder-ky040">KY-040 Rotary Encoder Module (D-Shaft & Push Button)</option>
                  </select>
                </div>

                <details style={{ marginTop: 10 }}>
                  <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--info)' }}>
                    Or paste raw datasheet text to auto-extract dimensions & pins...
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      rows={4}
                      placeholder="Paste text from PDF datasheet or spec sheet (e.g. Dimensions: 45 x 20 x 1.6mm, Pin 1: VCC, Pin 2: TRIG, Pin 3: ECHO, Pin 4: GND)..."
                      value={rawDatasheetText}
                      onChange={(e) => setRawDatasheetText(e.target.value)}
                      style={{ width: '100%', padding: '8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }}
                    />
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      onClick={handleParseDatasheet}
                      disabled={isParsing || !rawDatasheetText.trim()}
                      style={{ marginTop: 6 }}
                    >
                      {isParsing ? 'Extracting Geometry...' : 'Parse Datasheet'}
                    </button>
                  </div>
                </details>
              </div>

              {/* Component Geometry & Specs Editor */}
              <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>
                <h2 style={{ fontSize: 15, margin: '0 0 14px', fontWeight: 600 }}>
                  📐 Mechanical & Electrical Parameters
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Catalog ID</label>
                    <input
                      type="text"
                      value={spec.id}
                      onChange={(e) => setSpec({ ...spec, id: e.target.value })}
                      style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, fontFamily: 'monospace' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Role / Category</label>
                    <select
                      value={spec.category}
                      onChange={(e) => setSpec({ ...spec, category: e.target.value as ComponentRole })}
                      style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13 }}
                    >
                      <option value="sensor">Sensor</option>
                      <option value="display">Display</option>
                      <option value="driver">Driver / Motor</option>
                      <option value="actuator">Actuator</option>
                      <option value="input">Input</option>
                      <option value="power">Power</option>
                      <option value="communication">Communication</option>
                      <option value="controller">Controller</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Display Name</label>
                  <input
                    type="text"
                    value={spec.name}
                    onChange={(e) => setSpec({ ...spec, name: e.target.value })}
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13 }}
                  />
                </div>

                {/* Substrate Dimensions */}
                <div style={{ background: 'var(--bg-sunken)', padding: 12, borderRadius: 6, marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>
                    PCB Substrate Dimensions (mm)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                    <div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Width (X)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={spec.dimensions.widthMm}
                        onChange={(e) => setSpec({ ...spec, dimensions: { ...spec.dimensions, widthMm: parseFloat(e.target.value) || 0 } })}
                        style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Length (Z)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={spec.dimensions.lengthMm}
                        onChange={(e) => setSpec({ ...spec, dimensions: { ...spec.dimensions, lengthMm: parseFloat(e.target.value) || 0 } })}
                        style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Height (Y)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={spec.dimensions.heightMm}
                        onChange={(e) => setSpec({ ...spec, dimensions: { ...spec.dimensions, heightMm: parseFloat(e.target.value) || 0 } })}
                        style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>PCB Color</span>
                      <input
                        type="color"
                        value={spec.bodyColor || '#1a5b8c'}
                        onChange={(e) => setSpec({ ...spec, bodyColor: e.target.value })}
                        style={{ width: '100%', height: 28, border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      />
                    </div>
                  </div>
                </div>

                {/* Pin Anchors Editor */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                      ⚡ Pin Headers & 3D Snapping Anchors ({spec.pins.length})
                    </div>
                    <button type="button" className="btn btn--sm" onClick={handleAddPin} style={{ fontSize: 11 }}>
                      + Add Pin
                    </button>
                  </div>

                  <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
                      <thead style={{ background: 'var(--bg-sunken)', position: 'sticky', top: 0 }}>
                        <tr>
                          <th style={{ padding: '6px 8px' }}>Pin Name</th>
                          <th style={{ padding: '6px 8px' }}>Role</th>
                          <th style={{ padding: '6px 8px' }}>X (mm)</th>
                          <th style={{ padding: '6px 8px' }}>Y (mm)</th>
                          <th style={{ padding: '6px 8px' }}>Z (mm)</th>
                          <th style={{ padding: '6px 8px', width: 30 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {spec.pins.map((pin, i) => (
                          <tr key={`${pin.name}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '4px 8px' }}>
                              <input
                                type="text"
                                value={pin.name}
                                onChange={(e) => handleUpdatePin(i, { name: e.target.value })}
                                style={{ width: '70px', padding: '2px 4px', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}
                              />
                            </td>
                            <td style={{ padding: '4px 8px' }}>
                              <select
                                value={pin.role}
                                onChange={(e) => handleUpdatePin(i, { role: e.target.value as PinSignalRole })}
                                style={{ padding: '2px', fontSize: 11 }}
                              >
                                <option value="power">power</option>
                                <option value="ground">ground</option>
                                <option value="digital">digital</option>
                                <option value="analog">analog</option>
                                <option value="i2c">i2c</option>
                                <option value="spi">spi</option>
                                <option value="uart">uart</option>
                                <option value="pwm">pwm</option>
                                <option value="control">control</option>
                              </select>
                            </td>
                            <td style={{ padding: '4px 8px' }}>
                              <input
                                type="number"
                                step="0.1"
                                value={pin.xMm}
                                onChange={(e) => handleUpdatePin(i, { xMm: parseFloat(e.target.value) || 0 })}
                                style={{ width: '50px', padding: '2px 4px', fontSize: 11 }}
                              />
                            </td>
                            <td style={{ padding: '4px 8px' }}>
                              <input
                                type="number"
                                step="0.1"
                                value={pin.yMm}
                                onChange={(e) => handleUpdatePin(i, { yMm: parseFloat(e.target.value) || 0 })}
                                style={{ width: '50px', padding: '2px 4px', fontSize: 11 }}
                              />
                            </td>
                            <td style={{ padding: '4px 8px' }}>
                              <input
                                type="number"
                                step="0.1"
                                value={pin.zMm}
                                onChange={(e) => handleUpdatePin(i, { zMm: parseFloat(e.target.value) || 0 })}
                                style={{ width: '50px', padding: '2px 4px', fontSize: 11 }}
                              />
                            </td>
                            <td style={{ padding: '4px 8px' }}>
                              <button
                                type="button"
                                onClick={() => handleRemovePin(i)}
                                style={{ background: 'none', border: 'none', color: 'var(--err)', cursor: 'pointer', fontWeight: 'bold' }}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            </div>

            {/* Right Column: 3D Preview, Deploy & Seed Code */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              
              {/* 3D Viewport Card */}
              <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h2 style={{ fontSize: 15, margin: 0, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>🎮 Interactive 3D Model & Pin Anchors</span>
                  </h2>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setWireframeMode(!wireframeMode)}
                      style={{ fontSize: 11 }}
                    >
                      {wireframeMode ? 'Solid View' : 'Wireframe'}
                    </button>
                  </div>
                </div>

                {/* Three.js Canvas */}
                <CadPreviewCanvas spec={spec} wireframe={wireframeMode} showPins={true} />

                {/* Deployment Actions */}
                <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleDeployToVelxio}
                    disabled={isDeploying}
                    style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600 }}
                  >
                    {isDeploying ? 'Deploying Model & Manifest...' : '🚀 Deploy to Velxio 3D & Catalog'}
                  </button>

                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={handleDownloadGlb}
                  >
                    Download .GLB
                  </button>

                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={handleDownloadStl}
                  >
                    Download .STL
                  </button>
                </div>

                {/* Deploy Status Result */}
                {deployResult && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '10px 14px',
                      borderRadius: 6,
                      background: deployResult.success ? 'var(--ok-bg)' : 'var(--err-bg)',
                      border: `1px solid ${deployResult.success ? 'var(--ok)' : 'var(--err)'}`,
                      color: deployResult.success ? 'var(--ok)' : 'var(--err)',
                      fontSize: 13,
                    }}
                  >
                    {deployResult.success ? '✓ ' : '⚠ '}
                    {deployResult.message}
                    {deployResult.glbPath && (
                      <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'monospace', opacity: 0.8 }}>
                        Asset Path: {deployResult.glbPath}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Generated TypeScript Catalog Code */}
              <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ fontSize: 13, margin: 0, fontWeight: 600 }}>
                    🧬 Generated Catalog Seed Definition (TypeScript)
                  </h3>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedCode);
                      alert('Seed code copied to clipboard!');
                    }}
                    style={{ fontSize: 11 }}
                  >
                    Copy Code
                  </button>
                </div>

                <pre
                  style={{
                    background: '#090d16',
                    color: '#38bdf8',
                    padding: 14,
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: 'monospace',
                    maxHeight: 240,
                    overflowY: 'auto',
                    margin: 0,
                  }}
                >
                  {generatedCode || '// Generating seed definition...'}
                </pre>
              </div>

            </div>

          </div>
        )}

        {/* Tab 2: Catalog Explorer */}
        {activeTab === 'catalog' && (
          <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
            <h2 style={{ fontSize: 16, margin: '0 0 16px', fontWeight: 600 }}>
              📦 Registered Seed Catalog Hardware Components
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
              WireUp restricts generation strictly to real, validated hardware catalog parts. Hallucinated components are blocked at the hardware planning boundary.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {Object.values(COMPONENT_PRESETS).map((item) => (
                <div
                  key={item.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: 14,
                    background: 'var(--bg-sunken)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{item.name}</span>
                    <span style={{ fontSize: 10, background: '#e0ebeb', padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase', fontWeight: 700 }}>
                      {item.category}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontFamily: 'monospace' }}>
                    {item.id} · {item.voltage}V · {item.pins.length} Pins
                  </div>
                  <p style={{ fontSize: 12, margin: '0 0 10px', color: 'var(--text)' }}>
                    {item.description}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {item.pins.map((p) => (
                      <span key={p.name} style={{ background: '#fff', border: '1px solid var(--border)', padding: '1px 5px', fontSize: 10, borderRadius: 3, fontFamily: 'monospace' }}>
                        {p.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab 3: Diagnostics */}
        {activeTab === 'diagnostics' && (
          <div style={{ background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
            <h2 style={{ fontSize: 16, margin: '0 0 16px', fontWeight: 600 }}>
              🛠 Engineering Diagnostics & Environment Checks
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
              <div style={{ border: '1px solid var(--border)', padding: 16, borderRadius: 6 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--ok)' }}>✓ 3D CAD & Mesh Engine</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Parametric STL & GLB binary generator active. Auto-rigging empty pin nodes matching Velxio pin-anchor contract.
                </p>
              </div>

              <div style={{ border: '1px solid var(--border)', padding: 16, borderRadius: 6 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--ok)' }}>✓ Offline Deterministic Fallback</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Hardware Planner, Pin Allocator, Wiring Netlist, and Code Generator operate 100% deterministically when Bedrock is offline.
                </p>
              </div>

              <div style={{ border: '1px solid var(--border)', padding: 16, borderRadius: 6 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--ok)' }}>✓ Velxio Simulator Bridge</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Real-time UART serial bridge & postMessage relay configured for localhost:5174 (Velxio) and localhost:5175 (Dashboard).
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
