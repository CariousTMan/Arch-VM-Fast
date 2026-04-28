import { Router, type IRouter, type Request, type Response } from "express";
import { promises as fs, createReadStream } from "fs";
import {
  DIRECT_BOOT_SPECS,
  type DirectBootSpec,
  getDirectBootStatus,
  getReadyAssets,
  prepareDirectBoot,
} from "../lib/isoCache";

interface IsoEntry {
  name: string;
  url: string;
  description: string;
  sizeBytes?: number;
}

const ISO_CATALOG: Record<string, IsoEntry> = {
  arch: {
    name: "Arch Linux",
    description:
      "Latest official Arch ISO. Boot, run archinstall, partition, install. ~1.2 GB streamed on demand.",
    url: "https://geo.mirror.pkgbuild.com/iso/latest/archlinux-x86_64.iso",
  },
  alpine: {
    name: "Alpine Linux 3.20",
    description: "Minimal x86 Alpine virt ISO. Tiny and fast.",
    url: "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86/alpine-virt-3.20.3-x86.iso",
  },
  freedos: {
    name: "FreeDOS 1.3",
    description: "Open-source DOS for retro programs and games.",
    url: "https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/distributions/1.3/official/FD13-LiveCD.iso",
  },
  linux4: {
    name: "Linux 4 (tiny demo)",
    description:
      "Tiny ~5 MB Linux from the v86 demo. Boots in seconds with a busybox shell.",
    url: "https://copy.sh/v86/images/linux4.iso",
  },
  kolibri: {
    name: "KolibriOS",
    description:
      "Tiny GUI OS written in assembly. Whole desktop in under 100 MB.",
    url: "https://builds.kolibrios.org/eng/latest-iso.7z",
  },
};

function directBootSpec(id: string): DirectBootSpec | null {
  return DIRECT_BOOT_SPECS[id] ?? null;
}

const router: IRouter = Router();

router.get("/iso/list", (req, res) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.json({
    images: Object.entries(ISO_CATALOG).map(([id, v]) => ({
      id,
      name: v.name,
      description: v.description,
      proxyUrl: `/api/iso/${id}`,
      directBoot: directBootSpec(id) ? true : false,
      directBootInfoUrl: directBootSpec(id) ? `/api/iso/${id}/directboot` : null,
    })),
  });
});

function setProxyHeaders(res: Response): void {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
  );
  res.setHeader("Accept-Ranges", "bytes");
}

async function proxyIso(req: Request, entry: IsoEntry): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    "User-Agent": "linux-vm-proxy/1.0",
    Accept: "*/*",
  };
  const range = req.headers.range;
  if (range) headers["Range"] = range;
  return fetch(entry.url, {
    method: req.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
  });
}

router.head("/iso/:id", async (req, res) => {
  const entry = ISO_CATALOG[req.params.id];
  if (!entry) {
    res.status(404).end();
    return;
  }
  setProxyHeaders(res);
  try {
    const upstream = await proxyIso(req, entry);
    res.status(upstream.status);
    for (const h of [
      "content-length",
      "content-range",
      "content-type",
      "last-modified",
      "etag",
      "accept-ranges",
    ]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "ISO HEAD upstream error");
    if (!res.headersSent) res.status(502);
    res.end();
  }
});

router.get("/iso/:id", async (req, res) => {
  const entry = ISO_CATALOG[req.params.id];
  if (!entry) {
    res.status(404).json({ error: "Unknown ISO id" });
    return;
  }
  setProxyHeaders(res);
  try {
    const upstream = await proxyIso(req, entry);
    res.status(upstream.status);
    for (const h of [
      "content-length",
      "content-range",
      "content-type",
      "last-modified",
      "etag",
      "accept-ranges",
    ]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    let aborted = false;
    req.on("close", () => {
      aborted = true;
      reader.cancel().catch(() => undefined);
    });
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    req.log.error({ err, iso: req.params.id }, "ISO proxy error");
    if (!res.headersSent) {
      res.status(502).json({ error: "Upstream error" });
      return;
    }
    res.end();
  }
});

// ---- Direct kernel boot endpoints ----

router.get("/iso/:id/directboot", async (req, res) => {
  const id = req.params.id as string;
  const entry = ISO_CATALOG[id];
  const spec = directBootSpec(id);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (!entry || !spec) {
    res.status(404).json({ error: "No direct-boot spec for this ISO" });
    return;
  }
  // If we have cached assets on disk, surface them
  if (getDirectBootStatus(id).state === "absent") {
    await getReadyAssets(id, spec);
  }
  const status = getDirectBootStatus(id);
  res.json({
    id,
    status,
    cmdline:
      status.state === "ready" ? status.assets.cmdline : null,
    kernelUrl: `/api/iso/${id}/kernel`,
    initrdUrl: `/api/iso/${id}/initrd`,
    cdromUrl: `/api/iso/${id}`,
  });
});

router.post("/iso/:id/directboot/prepare", async (req, res) => {
  const id = req.params.id as string;
  const entry = ISO_CATALOG[id];
  const spec = directBootSpec(id);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (!entry || !spec) {
    res.status(404).json({ error: "No direct-boot spec for this ISO" });
    return;
  }
  // Fire and forget — client polls /directboot for progress
  prepareDirectBoot(id, spec, entry.url, req.log).catch(() => undefined);
  res.json({ status: getDirectBootStatus(id) });
});

async function serveCachedFile(
  req: Request,
  res: Response,
  assetKind: "kernel" | "initrd",
): Promise<void> {
  const id = req.params.id as string;
  const entry = ISO_CATALOG[id];
  const spec = directBootSpec(id);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!entry || !spec) {
    res.status(404).json({ error: "No direct-boot spec for this ISO" });
    return;
  }

  let assets = await getReadyAssets(id, spec);
  if (!assets) {
    // Trigger preparation, but tell the client to come back
    prepareDirectBoot(id, spec, entry.url, req.log).catch(() => undefined);
    res.status(503).json({
      error: "Direct-boot assets not ready",
      status: getDirectBootStatus(id),
    });
    return;
  }

  const filePath =
    assetKind === "kernel" ? assets.kernelFile : assets.initrdFile;
  const size = assetKind === "kernel" ? assets.kernelSize : assets.initrdSize;

  // Verify file still exists
  try {
    await fs.stat(filePath);
  } catch {
    res.status(503).json({
      error: "Cached asset missing, retrying",
      status: getDirectBootStatus(id),
    });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "public, max-age=86400");
  createReadStream(filePath).pipe(res);
}

router.get("/iso/:id/kernel", (req, res) => {
  void serveCachedFile(req, res, "kernel");
});

router.get("/iso/:id/initrd", (req, res) => {
  void serveCachedFile(req, res, "initrd");
});

export default router;
