export function createModuleWorker(url: URL | string): Worker {
  const urlStr = url instanceof URL ? url.href : String(url);
  try {
    if (
      typeof window !== "undefined" &&
      window.location?.origin &&
      urlStr.startsWith(window.location.origin)
    ) {
      return new Worker(url, { type: "module" });
    }
  } catch {}
  const blob = new Blob([`import ${JSON.stringify(urlStr)};`], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob), { type: "module" });
}
