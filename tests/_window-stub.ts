// Stub window, document, and animation frames for Node test runner
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).self === "undefined") {
  (globalThis as any).self = globalThis;
}
if (typeof (globalThis as any).document === "undefined") {
  const docListeners: Record<string, Function[]> = {};
  (globalThis as any).document = {
    hidden: false,
    documentElement: {
      requestFullscreen: async () => {},
    },
    exitFullscreen: async () => {},
    addEventListener: (event: string, fn: Function) => {
      docListeners[event] = docListeners[event] || [];
      docListeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: Function) => {
      if (docListeners[event]) {
        docListeners[event] = docListeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: { type: string }) => {
      (docListeners[event.type] || []).forEach((fn) => fn(event));
      return true;
    },
    createElement: () => ({
      style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
    }),
  };
}
if (typeof (globalThis as any).requestAnimationFrame === "undefined") {
  (globalThis as any).requestAnimationFrame = (fn: Function) => setTimeout(fn, 16);
  (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
}

export {};
