import { promises as fs, createWriteStream } from "fs";
import path from "path";
import os from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { IsoReader } from "./iso9660";

const CACHE_DIR = path.join(os.tmpdir(), "linux-vm-iso-cache");
const SECTOR = 2048;

export interface DirectBootSpec {
  kernelPath: string;
  initrdPath: string;
  /** Generates kernel cmdline given the volume label parsed from the ISO. */
  cmdline: (volumeLabel: string) => string;
}

export const DIRECT_BOOT_SPECS: Record<string, DirectBootSpec> = {
  arch: {
    kernelPath: "/arch/boot/x86_64/vmlinuz-linux",
    initrdPath: "/arch/boot/x86_64/initramfs-linux.img",
    cmdline: (label) =>
      `archisobasedir=arch archisolabel=${label} cms_verify=n copytoram=n console=tty0 rw quiet`,
  },
};

export interface CachedDirectBootAssets {
  kernelFile: string;
  initrdFile: string;
  volumeLabel: string;
  cmdline: string;
  kernelSize: number;
  initrdSize: number;
}

export type DirectBootStatus =
  | { state: "absent" }
  | { state: "preparing"; step: string; bytesDone: number; bytesTotal?: number }
  | { state: "ready"; assets: CachedDirectBootAssets }
  | { state: "error"; message: string };

const status = new Map<string, DirectBootStatus>();
const inflight = new Map<string, Promise<CachedDirectBootAssets>>();

export function getDirectBootStatus(id: string): DirectBootStatus {
  return status.get(id) ?? { state: "absent" };
}

interface PrepLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

async function fileSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return null;
  }
}

async function loadFromDisk(
  id: string,
  spec: DirectBootSpec,
): Promise<CachedDirectBootAssets | null> {
  const kernelFile = path.join(CACHE_DIR, `${id}.kernel`);
  const initrdFile = path.join(CACHE_DIR, `${id}.initrd`);
  const metaFile = path.join(CACHE_DIR, `${id}.meta.json`);
  const kSize = await fileSize(kernelFile);
  const iSize = await fileSize(initrdFile);
  const meta = await fs.readFile(metaFile, "utf-8").catch(() => null);
  if (!kSize || !iSize || !meta) return null;
  const parsed = JSON.parse(meta) as { volumeLabel: string };
  return {
    kernelFile,
    initrdFile,
    volumeLabel: parsed.volumeLabel,
    cmdline: spec.cmdline(parsed.volumeLabel),
    kernelSize: kSize,
    initrdSize: iSize,
  };
}

async function downloadIso(
  isoUrl: string,
  isoFile: string,
  id: string,
): Promise<void> {
  const res = await fetch(isoUrl, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`ISO download failed: HTTP ${res.status}`);
  }
  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : undefined;

  // Track progress as data flows
  let bytesDone = 0;
  const tracked = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = res.body!.getReader();
      const pump = async (): Promise<void> => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesDone += value.byteLength;
          status.set(id, {
            state: "preparing",
            step: "downloading-iso",
            bytesDone,
            bytesTotal: total,
          });
          controller.enqueue(value);
        }
        controller.close();
      };
      pump().catch((err: unknown) => controller.error(err));
    },
  });

  await pipeline(Readable.fromWeb(tracked as never), createWriteStream(isoFile));
}

async function extract(
  isoFile: string,
  spec: DirectBootSpec,
  id: string,
): Promise<CachedDirectBootAssets> {
  status.set(id, {
    state: "preparing",
    step: "parsing-iso",
    bytesDone: 0,
  });
  const iso = await IsoReader.open(isoFile);
  try {
    const info = await iso.parseVolumeInfo();
    const kernel = await iso.findFile(spec.kernelPath);
    const initrd = await iso.findFile(spec.initrdPath);
    if (!kernel)
      throw new Error(`Could not find kernel at ${spec.kernelPath} in ISO`);
    if (!initrd)
      throw new Error(`Could not find initrd at ${spec.initrdPath} in ISO`);

    const kernelFile = path.join(CACHE_DIR, `${id}.kernel`);
    const initrdFile = path.join(CACHE_DIR, `${id}.initrd`);
    const metaFile = path.join(CACHE_DIR, `${id}.meta.json`);

    status.set(id, {
      state: "preparing",
      step: "extracting-kernel",
      bytesDone: 0,
      bytesTotal: kernel.length,
    });
    const kBuf = await iso.read(kernel.lba * SECTOR, kernel.length);
    await fs.writeFile(kernelFile, kBuf);

    status.set(id, {
      state: "preparing",
      step: "extracting-initrd",
      bytesDone: 0,
      bytesTotal: initrd.length,
    });
    // Stream initrd extraction in chunks to keep memory bounded
    const out = await fs.open(initrdFile, "w");
    try {
      const CHUNK = 4 * 1024 * 1024;
      let off = 0;
      while (off < initrd.length) {
        const take = Math.min(CHUNK, initrd.length - off);
        const buf = await iso.read(initrd.lba * SECTOR + off, take);
        await out.write(buf);
        off += take;
        status.set(id, {
          state: "preparing",
          step: "extracting-initrd",
          bytesDone: off,
          bytesTotal: initrd.length,
        });
      }
    } finally {
      await out.close();
    }

    await fs.writeFile(
      metaFile,
      JSON.stringify({ volumeLabel: info.volumeLabel }),
    );

    return {
      kernelFile,
      initrdFile,
      volumeLabel: info.volumeLabel,
      cmdline: spec.cmdline(info.volumeLabel),
      kernelSize: kernel.length,
      initrdSize: initrd.length,
    };
  } finally {
    await iso.close();
  }
}

export async function prepareDirectBoot(
  id: string,
  spec: DirectBootSpec,
  isoUrl: string,
  log: PrepLogger,
): Promise<CachedDirectBootAssets> {
  const existing = inflight.get(id);
  if (existing) return existing;

  const promise = (async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    // Reuse cached extraction if present
    const cached = await loadFromDisk(id, spec);
    if (cached) {
      status.set(id, { state: "ready", assets: cached });
      log.info({ id, label: cached.volumeLabel }, "direct-boot cache hit");
      return cached;
    }

    const isoFile = path.join(CACHE_DIR, `${id}.iso`);
    log.info({ id, isoUrl }, "downloading ISO for direct-boot extraction");
    status.set(id, {
      state: "preparing",
      step: "downloading-iso",
      bytesDone: 0,
    });
    await downloadIso(isoUrl, isoFile, id);

    log.info({ id }, "extracting kernel + initrd");
    const assets = await extract(isoFile, spec, id);

    // ISO no longer needed locally — cdrom proxy reads from upstream
    await fs.unlink(isoFile).catch(() => undefined);

    status.set(id, { state: "ready", assets });
    log.info(
      { id, label: assets.volumeLabel, cmdline: assets.cmdline },
      "direct-boot ready",
    );
    return assets;
  })().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    status.set(id, { state: "error", message });
    log.error({ id, err }, "direct-boot prep failed");
    throw err;
  });

  inflight.set(id, promise);
  promise.finally(() => {
    inflight.delete(id);
  });
  return promise;
}

export async function getReadyAssets(
  id: string,
  spec: DirectBootSpec,
): Promise<CachedDirectBootAssets | null> {
  const s = status.get(id);
  if (s?.state === "ready") return s.assets;
  // Try loading from disk in case server restarted
  const cached = await loadFromDisk(id, spec);
  if (cached) {
    status.set(id, { state: "ready", assets: cached });
    return cached;
  }
  return null;
}
