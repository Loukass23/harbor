type MediaLike = { paused: boolean; pause(): void };

type DocumentLike = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  querySelectorAll(selector: string): ArrayLike<MediaLike>;
};

/**
 * Pauses playing media when the app is sent to the background (Home, Smart Hub,
 * another app). Nothing resumes automatically: the viewer picks up where they
 * left off. The AVPlay bridge adds its own suspend/restore on the same event.
 */
export function installLifecycle(doc: DocumentLike): void {
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState !== "hidden") return;
    for (const media of Array.from(doc.querySelectorAll("video, audio"))) {
      if (!media.paused) media.pause();
    }
  });
}
