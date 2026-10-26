import Link from "next/link";
import { redirect } from "next/navigation";
import { getUnitsPaginated } from "@/lib/db";
import { isValidGtin14 } from "@/lib/gs1";

interface Props {
  params: Promise<{
    gtin: string;
    lot: string;
    serial: string;
  }>;
  searchParams: Promise<{
    "17"?: string;
  }>;
}

export default async function Gs1DigitalLinkResolverPage({ params, searchParams }: Props) {
  const { gtin, lot, serial } = await params;
  const query = await searchParams;
  const expiry = query["17"];

  const decodedLot = decodeURIComponent(lot);
  const decodedSerial = decodeURIComponent(serial);

  // Validate GTIN
  const gtinValid = isValidGtin14(gtin);

  // Look for matching unit in local database projection
  const { units } = await getUnitsPaginated({ limit: 100 });
  const matchedUnit = units.find(
    (u) =>
      (u.gtin === gtin || !u.gtin) &&
      (u.lot?.toLowerCase() === decodedLot.toLowerCase() ||
        u.metadata?.toLowerCase().includes(decodedLot.toLowerCase()))
  );

  // If a direct match with unitId is found, redirect to verify
  if (matchedUnit) {
    redirect(`/verify?unitId=${matchedUnit.unitId}&gtin=${gtin}&lot=${encodeURIComponent(decodedLot)}`);
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg bg-slate-900/80 border border-slate-800 rounded-2xl p-6 sm:p-8 backdrop-blur-xl shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold">
            GS1
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">GS1 Digital Link Resolver</h1>
            <p className="text-xs text-slate-400">Standard Healthcare Product Identification</p>
          </div>
        </div>

        <div className="space-y-4 bg-slate-950/60 rounded-xl p-4 border border-slate-800/80 font-mono text-sm">
          <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
            <span className="text-slate-400">GTIN (01):</span>
            <span className="text-emerald-400 font-semibold">{gtin}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
            <span className="text-slate-400">Batch/Lot (10):</span>
            <span className="text-white">{decodedLot}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
            <span className="text-slate-400">Serial (21):</span>
            <span className="text-white">{decodedSerial}</span>
          </div>
          {expiry && (
            <div className="flex justify-between items-center py-1">
              <span className="text-slate-400">Expiry (17):</span>
              <span className="text-amber-400">{expiry}</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-300 text-xs leading-relaxed">
            {gtinValid ? (
              <span>✓ Valid GTIN-14 Luhn check digit. Looking up on-chain pedigree record...</span>
            ) : (
              <span>⚠️ Notice: Non-standard GTIN check digit detected. Verify packaging integrity.</span>
            )}
          </div>

          <Link
            href={`/verify?gtin=${gtin}&lot=${encodeURIComponent(decodedLot)}`}
            className="w-full text-center py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition shadow-lg shadow-emerald-900/30"
          >
            Open Verification Portal
          </Link>
          <Link
            href="/"
            className="w-full text-center py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium rounded-xl transition"
          >
            Return to Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
