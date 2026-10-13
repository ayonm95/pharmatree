/**
 * Dynamic QR Code generator to avoid loading heavy qrcode library on initial page bundle
 */
export async function generateQrDataUrl(text: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toDataURL(text, {
    margin: 1,
    width: 256,
    color: {
      dark: "#0f172a",
      light: "#ffffff",
    },
  });
}
