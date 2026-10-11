import { lazy, Suspense } from "react";
import type { BpOnboardStepProps } from "@/views/big-picture/bp-onboarding-frame";
import type { BpPlatformSetup } from "@/views/big-picture/bp-platform";

export { CompanionRunner } from "./companion-runner";

// The views load on first open so they stay out of the boot bundle. Each gets
// its own boundary: the shell's would blank the whole screen while it loads.
const LazyPane = lazy(() => import("./companion-pane").then((m) => ({ default: m.CompanionPane })));
const LazyStep = lazy(() => import("./companion-pane").then((m) => ({ default: m.CompanionStep })));

function Pane(props: { onBack: () => void }) {
  return (
    <Suspense fallback={null}>
      <LazyPane {...props} />
    </Suspense>
  );
}

function Step(props: BpOnboardStepProps) {
  return (
    <Suspense fallback={null}>
      <LazyStep {...props} />
    </Suspense>
  );
}

export const companionSetup: BpPlatformSetup = {
  label: "Pair with a computer",
  detail: "Stream torrents and bring settings over from Harbor on a computer",
  Pane,
  onboarding: {
    eyebrow: "Your computer",
    headline: "Pair with Harbor on your computer",
    body: "It streams torrents to this TV and sends your accounts, keys and addons. Nothing to type.",
    primary: "Set this up on the TV instead",
    primaryDone: "Continue",
    Step,
  },
};
