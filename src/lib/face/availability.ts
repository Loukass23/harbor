let available = true;

/**
 * Turns X-Ray face matching off for a platform that cannot use it, such as one
 * whose video plays on a hardware plane that a canvas cannot capture. X-Ray
 * then lists the cast without scanning frames.
 */
export function setFaceIdAvailable(value: boolean): void {
  available = value;
}

export function faceIdAvailable(): boolean {
  return available;
}
