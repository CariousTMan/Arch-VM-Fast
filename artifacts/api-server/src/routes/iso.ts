import { Router, type IRouter, type Request } from "express";

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

const router: IRouter = Router();

router.get("/iso/list", (req, res) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.json({
    images: Object.entries(ISO_CATALOG).map(([id, v]) => ({
      id,
      name: v.name,
      description: v.description,
      proxyUrl: `/api/iso/${id}`,
    })),
  });
});

function setProxyHeaders(res: import("express").Response): void {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
  );
  res.setHeader("Accept-Ranges", "bytes");
}

async function proxyIso(req: Request, entry: IsoEntry): Promise<Response> {
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

export default router;
