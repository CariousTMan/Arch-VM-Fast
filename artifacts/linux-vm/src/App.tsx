import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadV86, v86AssetUrl } from "./lib/v86Loader";
import {
  deleteState,
  listStates,
  loadState,
  saveState,
  saveDiskImage,
  loadDiskImage,
  deleteDiskImage,
  type SavedStateMeta,
} from "./lib/stateStore";
import type { V86Instance } from "./v86";

interface IsoDescriptor {
  id: string;
  name: string;
  description: string;
  proxyUrl: string;
}

interface BootProfile {
  isoId: string;
  isoName: string;
  isoUrl: string;
  memoryMb: number;
  vgaMemoryMb: number;
  diskGb: number;
  networking: boolean;
  bootFromHd: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "loading"; step: string }
  | { kind: "running" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

const HD_PERSIST_KEY = "default";

const DEFAULTS: Omit<BootProfile, "isoId" | "isoName" | "isoUrl"> = {
  memoryMb: 1024,
  vgaMemoryMb: 32,
  diskGb: 2,
  networking: true,
  bootFromHd: false,
};

const MAX_DISK_GB = 4;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function App() {
  const [catalog, setCatalog] = useState<IsoDescriptor[] | null>(null);
  const [selectedIso, setSelectedIso] = useState<string>("arch");
  const [memoryMb, setMemoryMb] = useState(DEFAULTS.memoryMb);
  const [vgaMemoryMb, setVgaMemoryMb] = useState(DEFAULTS.vgaMemoryMb);
  const [diskGb, setDiskGb] = useState(DEFAULTS.diskGb);
  const [networking, setNetworking] = useState(DEFAULTS.networking);
  const [bootFromHd, setBootFromHd] = useState(DEFAULTS.bootFromHd);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [savedStates, setSavedStates] = useState<SavedStateMeta[]>([]);
  const [mouseLocked, setMouseLocked] = useState(false);
  const [netStatus, setNetStatus] = useState<"off" | "connecting" | "online">(
    "off",
  );
  const [logLines, setLogLines] = useState<string[]>([]);

  const screenContainerRef = useRef<HTMLDivElement>(null);
  const emulatorRef = useRef<V86Instance | null>(null);
  const profileRef = useRef<BootProfile | null>(null);
  const diskBufferRef = useRef<ArrayBuffer | null>(null);

  const apiBase = useMemo(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    return `${base}/api`;
  }, []);

  const pushLog = useCallback((line: string) => {
    setLogLines((prev) => {
      const next = [...prev, `[${new Date().toLocaleTimeString()}] ${line}`];
      return next.length > 80 ? next.slice(next.length - 80) : next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/iso/list`)
      .then((r) => r.json())
      .then((data: { images: IsoDescriptor[] }) => {
        if (cancelled) return;
        setCatalog(data.images);
        if (data.images.length && !data.images.some((i) => i.id === "arch")) {
          setSelectedIso(data.images[0].id);
        }
      })
      .catch((err) => {
        pushLog(`Failed to load ISO catalog: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, pushLog]);

  const refreshSavedStates = useCallback(async () => {
    try {
      const states = await listStates();
      setSavedStates(states);
    } catch (err) {
      pushLog(`Could not list saved states: ${String(err)}`);
    }
  }, [pushLog]);

  useEffect(() => {
    void refreshSavedStates();
  }, [refreshSavedStates]);

  const persistDisk = useCallback(async () => {
    const profile = profileRef.current;
    const buf = diskBufferRef.current;
    if (!profile || !buf) return;
    try {
      await saveDiskImage(profile.isoId, buf);
      pushLog(
        `Persisted virtual disk for "${profile.isoId}" (${fmtBytes(buf.byteLength)}).`,
      );
    } catch (err) {
      pushLog(`Could not persist disk: ${String(err)}`);
    }
  }, [pushLog]);

  const teardown = useCallback(() => {
    const em = emulatorRef.current;
    if (em) {
      try {
        em.destroy();
      } catch {
        // ignore
      }
      emulatorRef.current = null;
    }
    profileRef.current = null;
    diskBufferRef.current = null;
    setMouseLocked(false);
    setNetStatus("off");
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const boot = useCallback(
    async (opts?: { restoreKey?: string }) => {
      if (emulatorRef.current) {
        pushLog("VM already running. Stop first.");
        return;
      }
      const iso = catalog?.find((i) => i.id === selectedIso);
      if (!iso) {
        pushLog("No ISO selected.");
        return;
      }
      const profile: BootProfile = {
        isoId: iso.id,
        isoName: iso.name,
        isoUrl: `${apiBase}${iso.proxyUrl.startsWith("/api") ? iso.proxyUrl.slice(4) : iso.proxyUrl}`,
        memoryMb,
        vgaMemoryMb,
        diskGb,
        networking,
        bootFromHd,
      };
      profileRef.current = profile;

      setPhase({ kind: "loading", step: "Loading v86 runtime..." });
      pushLog(`Booting ${iso.name}`);

      try {
        const V86 = await loadV86();

        const container = screenContainerRef.current;
        if (!container) throw new Error("Screen container missing");

        let initialState: ArrayBuffer | undefined;
        if (opts?.restoreKey) {
          setPhase({
            kind: "loading",
            step: "Restoring saved machine state from local storage...",
          });
          const saved = await loadState(opts.restoreKey);
          if (!saved) throw new Error("Saved state not found");
          initialState = saved.state;
          pushLog(
            `Restoring "${opts.restoreKey}" (${fmtBytes(saved.meta.size)})`,
          );
        }

        setPhase({
          kind: "loading",
          step: "Preparing virtual hard disk...",
        });
        const existingDisk = await loadDiskImage(profile.isoId);
        let diskBuffer: ArrayBuffer;
        if (existingDisk && existingDisk.size === profile.diskGb * 1024 ** 3) {
          diskBuffer = existingDisk.buffer;
          pushLog(
            `Reusing saved disk for "${profile.isoId}" (${fmtBytes(existingDisk.size)})`,
          );
        } else {
          if (existingDisk) {
            pushLog(
              `Disk size changed (${fmtBytes(existingDisk.size)} → ${profile.diskGb} GB). Allocating fresh disk.`,
            );
            await deleteDiskImage(profile.isoId);
          }
          try {
            diskBuffer = new ArrayBuffer(profile.diskGb * 1024 ** 3);
          } catch (allocErr) {
            throw new Error(
              `Could not allocate ${profile.diskGb} GB virtual disk in this browser (${String(allocErr)}). Try a smaller disk size.`,
            );
          }
          pushLog(`Allocated blank ${profile.diskGb} GB virtual disk.`);
        }
        diskBufferRef.current = diskBuffer;

        setPhase({
          kind: "loading",
          step: profile.bootFromHd
            ? "Booting installed system from virtual hard disk..."
            : `Streaming ${iso.name} ISO from proxy...`,
        });

        if (profile.networking) setNetStatus("connecting");

        const em = new V86({
          wasm_path: v86AssetUrl("v86.wasm"),
          memory_size: profile.memoryMb * 1024 * 1024,
          vga_memory_size: profile.vgaMemoryMb * 1024 * 1024,
          screen_container: container,
          bios: { url: v86AssetUrl("seabios.bin") },
          vga_bios: { url: v86AssetUrl("vgabios.bin") },
          cdrom: initialState
            ? undefined
            : { url: profile.isoUrl, async: true },
          hda: initialState ? undefined : { buffer: diskBuffer, async: false },
          initial_state: initialState ? { buffer: initialState } : undefined,
          network_relay_url: profile.networking
            ? "wss://relay.widgetry.org/"
            : undefined,
          boot_order: profile.bootFromHd ? 0x132 : 0x213,
          autostart: true,
          acpi: true,
        });

        emulatorRef.current = em;

        em.add_listener("emulator-ready", () => {
          pushLog("Emulator ready.");
        });
        em.add_listener("emulator-started", () => {
          setPhase({ kind: "running" });
          pushLog("VM is running.");
        });
        em.add_listener("emulator-stopped", () => {
          pushLog("VM stopped.");
        });
        em.add_listener("download-progress", (raw) => {
          const d = raw as {
            file_name?: string;
            loaded?: number;
            total?: number;
          };
          if (d.total && d.loaded != null && d.file_name) {
            const pct = ((d.loaded / d.total) * 100).toFixed(1);
            setPhase({
              kind: "loading",
              step: `Streaming ${d.file_name.split("/").pop()} ${pct}%`,
            });
          }
        });
        em.add_listener("download-error", (raw) => {
          const d = raw as { file_name?: string };
          pushLog(`Download error: ${d.file_name ?? "unknown"}`);
        });
        em.add_listener("net-mac", (raw) => {
          pushLog(`Network MAC: ${String(raw)}`);
        });
        em.add_listener("eth-receive-end", () => {
          if (netStatus !== "online") setNetStatus("online");
        });
        em.add_listener("mouse-enable", (raw) => {
          setMouseLocked(Boolean(raw));
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushLog(`Boot failed: ${message}`);
        setPhase({ kind: "error", message });
        teardown();
      }
    },
    [
      apiBase,
      catalog,
      selectedIso,
      memoryMb,
      vgaMemoryMb,
      diskGb,
      networking,
      bootFromHd,
      pushLog,
      netStatus,
      teardown,
    ],
  );

  const stop = useCallback(async () => {
    await persistDisk();
    teardown();
    setPhase({ kind: "stopped" });
    pushLog("VM destroyed.");
  }, [persistDisk, pushLog, teardown]);

  const restart = useCallback(() => {
    const em = emulatorRef.current;
    if (!em) return;
    try {
      em.restart();
      pushLog("VM restarted.");
    } catch (err) {
      pushLog(`Restart failed: ${String(err)}`);
    }
  }, [pushLog]);

  const sendCtrlAltDel = useCallback(() => {
    const em = emulatorRef.current;
    if (!em) return;
    em.keyboard_send_scancodes([
      0x1d, 0x38, 0x53,
      0xd3 | 0x80, 0xb8, 0x9d,
    ]);
    pushLog("Sent Ctrl+Alt+Del");
  }, [pushLog]);

  const goFullscreen = useCallback(() => {
    const em = emulatorRef.current;
    if (!em) return;
    em.screen_go_fullscreen();
  }, []);

  const lockMouse = useCallback(() => {
    const em = emulatorRef.current;
    if (!em) return;
    em.lock_mouse();
  }, []);

  const handleSaveState = useCallback(async () => {
    const em = emulatorRef.current;
    const profile = profileRef.current;
    if (!em || !profile) {
      pushLog("Nothing to save — VM is not running.");
      return;
    }
    const key = window.prompt(
      "Save name (use the same name to overwrite):",
      `${profile.isoId}-${new Date().toISOString().slice(0, 16).replace("T", "-")}`,
    );
    if (!key) return;
    try {
      pushLog(`Capturing machine state...`);
      const state = await em.save_state();
      const meta = await saveState(key, profile.isoId, state);
      pushLog(`Saved "${key}" (${fmtBytes(meta.size)}) to local storage.`);
      await persistDisk();
      void refreshSavedStates();
    } catch (err) {
      pushLog(`Save failed: ${String(err)}`);
    }
  }, [persistDisk, pushLog, refreshSavedStates]);

  const handleRestoreSlot = useCallback(
    async (slot: SavedStateMeta) => {
      teardown();
      setSelectedIso(slot.iso);
      await new Promise((r) => setTimeout(r, 50));
      await boot({ restoreKey: slot.key });
    },
    [boot, teardown],
  );

  const handleDeleteSlot = useCallback(
    async (slot: SavedStateMeta) => {
      if (!confirm(`Delete saved state "${slot.key}"?`)) return;
      try {
        await deleteState(slot.key);
        await refreshSavedStates();
      } catch (err) {
        pushLog(`Delete failed: ${String(err)}`);
      }
    },
    [pushLog, refreshSavedStates],
  );

  const isRunning = phase.kind === "running" || phase.kind === "loading";
  const selectedIsoMeta = catalog?.find((i) => i.id === selectedIso);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▌</span>
          <span className="brand-name">linux.vm</span>
          <span className="brand-tag">browser-native x86 emulator</span>
        </div>
        <div className="topbar-status">
          <StatusPill phase={phase} />
          {phase.kind === "running" && (
            <span className="net-pill" data-state={netStatus}>
              <span className="net-dot" />
              net {netStatus}
            </span>
          )}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <SectionHeader title="Boot media" subtitle="Pick an OS to boot" />
          <div className="iso-list">
            {!catalog && <div className="muted">Loading catalog…</div>}
            {catalog?.map((i) => (
              <button
                key={i.id}
                className="iso-card"
                data-active={selectedIso === i.id}
                disabled={isRunning}
                onClick={() => setSelectedIso(i.id)}
              >
                <div className="iso-card-head">
                  <span className="iso-name">{i.name}</span>
                  {i.id === "arch" && (
                    <span className="iso-badge">primary</span>
                  )}
                </div>
                <div className="iso-desc">{i.description}</div>
              </button>
            ))}
          </div>

          <SectionHeader title="Hardware" subtitle="Sized at boot" />
          <Slider
            label="RAM"
            value={memoryMb}
            min={64}
            max={4096}
            step={64}
            unit="MB"
            disabled={isRunning}
            onChange={setMemoryMb}
          />
          <Slider
            label="VGA"
            value={vgaMemoryMb}
            min={8}
            max={128}
            step={8}
            unit="MB"
            disabled={isRunning}
            onChange={setVgaMemoryMb}
          />
          <Slider
            label="Virtual disk"
            value={diskGb}
            min={1}
            max={MAX_DISK_GB}
            step={1}
            unit="GB"
            disabled={isRunning}
            onChange={setDiskGb}
          />
          <div className="hint">
            Disk lives in browser memory while running and is persisted to
            IndexedDB on Power off / Save state. Browser ArrayBuffer limits
            cap the size at ~{MAX_DISK_GB} GB.
          </div>

          <SectionHeader title="Boot" subtitle="" />
          <Toggle
            label="Internet (WebSocket relay)"
            checked={networking}
            onChange={setNetworking}
            disabled={isRunning}
          />
          <Toggle
            label="Boot from hard disk first"
            checked={bootFromHd}
            onChange={setBootFromHd}
            disabled={isRunning}
            hint="Use after you've installed the OS to the virtual disk."
          />

          <div className="primary-actions">
            {!isRunning && (
              <button
                className="btn btn-primary btn-full"
                disabled={!catalog}
                onClick={() => void boot()}
              >
                ▶ Power on
              </button>
            )}
            {isRunning && (
              <>
                <button className="btn btn-full" onClick={restart}>
                  ↻ Reset
                </button>
                <button
                  className="btn btn-full btn-danger"
                  onClick={() => void stop()}
                >
                  ⏻ Power off
                </button>
              </>
            )}
          </div>

          {savedStates.length > 0 && (
            <>
              <SectionHeader
                title="Saved states"
                subtitle={`${savedStates.length} snapshot${savedStates.length === 1 ? "" : "s"} in this browser`}
              />
              <div className="state-list">
                {savedStates.map((s) => (
                  <div key={s.key} className="state-card">
                    <div className="state-head">
                      <span className="state-key">{s.key}</span>
                      <span className="state-size">{fmtBytes(s.size)}</span>
                    </div>
                    <div className="state-meta">
                      <span>{s.iso}</span>
                      <span>{fmtAgo(s.createdAt)}</span>
                    </div>
                    <div className="state-actions">
                      <button
                        className="btn btn-sm"
                        disabled={isRunning}
                        onClick={() => void handleRestoreSlot(s)}
                      >
                        Resume
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => void handleDeleteSlot(s)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>

        <main className="main">
          <div className="main-toolbar">
            <div className="vm-info">
              <span className="vm-label">VM</span>
              <span className="vm-name">
                {selectedIsoMeta?.name ?? "—"}
              </span>
              <span className="vm-sep">·</span>
              <span className="vm-spec">{memoryMb} MB RAM</span>
              <span className="vm-sep">·</span>
              <span className="vm-spec">{diskGb} GB disk</span>
            </div>
            <div className="vm-actions">
              <button
                className="btn btn-sm"
                onClick={lockMouse}
                disabled={phase.kind !== "running"}
                title="Esc releases the mouse"
              >
                {mouseLocked ? "● mouse captured" : "Capture mouse"}
              </button>
              <button
                className="btn btn-sm"
                onClick={sendCtrlAltDel}
                disabled={phase.kind !== "running"}
              >
                Ctrl+Alt+Del
              </button>
              <button
                className="btn btn-sm"
                onClick={() => void handleSaveState()}
                disabled={phase.kind !== "running"}
              >
                Save state
              </button>
              <button
                className="btn btn-sm"
                onClick={goFullscreen}
                disabled={phase.kind !== "running"}
              >
                Fullscreen
              </button>
            </div>
          </div>

          <div className="screen-frame">
            <div ref={screenContainerRef} className="screen-container">
              <canvas className="v86-canvas" />
              <div className="v86-text" />
            </div>

            {phase.kind !== "running" && (
              <div className="overlay">
                {phase.kind === "idle" && <IdleOverlay iso={selectedIsoMeta} />}
                {phase.kind === "loading" && (
                  <LoadingOverlay step={phase.step} iso={selectedIsoMeta} />
                )}
                {phase.kind === "stopped" && (
                  <div className="overlay-card">
                    <div className="overlay-emoji">⏻</div>
                    <h3>VM powered off</h3>
                    <p>Configure and press Power on to boot again.</p>
                  </div>
                )}
                {phase.kind === "error" && (
                  <div className="overlay-card">
                    <div className="overlay-emoji error">!</div>
                    <h3>Boot failed</h3>
                    <pre className="overlay-error">{phase.message}</pre>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="logs">
            <div className="logs-head">
              <span>Activity</span>
              <button
                className="btn btn-xs"
                onClick={() => setLogLines([])}
              >
                Clear
              </button>
            </div>
            <div className="logs-body">
              {logLines.length === 0 ? (
                <span className="muted">Nothing yet. Boot a VM to start.</span>
              ) : (
                logLines.map((line, idx) => (
                  <div key={idx} className="log-line">
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function StatusPill({ phase }: { phase: Phase }) {
  const map: Record<Phase["kind"], { label: string; klass: string }> = {
    idle: { label: "idle", klass: "idle" },
    loading: { label: "booting", klass: "booting" },
    running: { label: "running", klass: "ready" },
    stopped: { label: "off", klass: "idle" },
    error: { label: "error", klass: "error" },
  };
  const m = map[phase.kind];
  return (
    <span className={`status-pill ${m.klass}`}>
      <span className="status-dot" />
      {m.label}
    </span>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="section-head">
      <div className="section-title">{title}</div>
      {subtitle && <div className="section-sub">{subtitle}</div>}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider">
      <div className="slider-row">
        <label>{label}</label>
        <span className="slider-value">
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="toggle" data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

function IdleOverlay({ iso }: { iso?: IsoDescriptor }) {
  return (
    <div className="overlay-card">
      <div className="overlay-emoji">▌</div>
      <h3>Press Power on to boot</h3>
      <p>
        {iso ? (
          <>
            Selected: <strong>{iso.name}</strong>
          </>
        ) : (
          "Select boot media on the left."
        )}
      </p>
      <ul className="bullet">
        <li>
          The ISO streams from the proxy on demand — only the blocks v86
          actually reads are downloaded.
        </li>
        <li>
          Run <code>archinstall</code> (or <code>fdisk /dev/sda</code> →{" "}
          <code>pacstrap</code>) to install Arch onto the virtual disk.
        </li>
        <li>
          When done, save a snapshot, then enable{" "}
          <em>Boot from hard disk first</em> on the next boot.
        </li>
      </ul>
    </div>
  );
}

function LoadingOverlay({
  step,
  iso,
}: {
  step: string;
  iso?: IsoDescriptor;
}) {
  return (
    <div className="overlay-card">
      <div className="overlay-emoji booting">▌</div>
      <h3>{iso?.name ?? "Booting"}</h3>
      <p className="muted">{step}</p>
      <div className="boot-bar">
        <div className="boot-bar-fill" />
      </div>
      <p className="boot-hint">
        First boot is slow — v86 is a real CPU interpreter. Arch ISO can take
        several minutes to reach a prompt. Hang in there.
      </p>
    </div>
  );
}
