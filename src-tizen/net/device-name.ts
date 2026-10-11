// The name the computer shows in its "Allow this device?" dialog. productinfo
// needs its privilege (config.xml.tpl) and throws without it, so it is guarded.

type ProductInfo = { getRealModel?(): string; getModel?(): string };

export function tvName(
  productinfo: ProductInfo | null | undefined = (
    globalThis as { webapis?: { productinfo?: ProductInfo } }
  ).webapis?.productinfo,
): string {
  let model = "";
  try {
    model = productinfo?.getRealModel?.() || productinfo?.getModel?.() || "";
  } catch {
    model = "";
  }
  const clean = model
    .replace(/[^\w .-]/g, "")
    .trim()
    .slice(0, 32);
  return clean ? `Samsung TV ${clean}` : "Samsung TV";
}
