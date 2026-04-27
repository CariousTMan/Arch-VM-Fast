import type { V86Constructor } from "../v86";

let loadingPromise: Promise<V86Constructor> | null = null;

const SUPPRESSED_WARN_PATTERNS = [
  /^SyncFileBuffer: Allocating buffer of /,
  /^Missing import: /,
  /^Note: Memory size mismatch\./,
];

let warnPatched = false;
function patchConsoleWarn(): void {
  if (warnPatched || typeof console === "undefined") return;
  warnPatched = true;
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
      for (const pat of SUPPRESSED_WARN_PATTERNS) {
        if (pat.test(first)) return;
      }
    }
    original(...args);
  };
}

export function loadV86(): Promise<V86Constructor> {
  if (typeof window !== "undefined" && window.V86) {
    patchConsoleWarn();
    return Promise.resolve(window.V86);
  }
  if (loadingPromise) return loadingPromise;
  patchConsoleWarn();
  loadingPromise = new Promise<V86Constructor>((resolve, reject) => {
    const base = import.meta.env.BASE_URL;
    const script = document.createElement("script");
    script.src = `${base}v86/libv86.js`;
    script.async = true;
    script.onload = () => {
      const ctor = window.V86;
      if (!ctor) {
        reject(new Error("libv86 loaded but window.V86 is undefined"));
        return;
      }
      resolve(ctor);
    };
    script.onerror = () =>
      reject(new Error(`Failed to load ${script.src}`));
    document.head.appendChild(script);
  });
  return loadingPromise;
}

export function v86AssetUrl(name: string): string {
  const base = import.meta.env.BASE_URL;
  return `${base}v86/${name}`;
}
