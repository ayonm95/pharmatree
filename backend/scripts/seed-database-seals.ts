import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../frontend/.env.local") });

// Known demo unit secrets matching backend/deployments/sepolia-units.json
const DEMO_UNITS = [
  { unitId: 1, serial: "CD360DWJZHAXPCNRDVF7", sealSecret: "P5NS8WJK6RAK" },
  { unitId: 2, serial: "SGGJ9W55VG8HTN8N0NMM", sealSecret: "NBHVG59Y348R" },
  { unitId: 3, serial: "X9Y4ZDHJHV2ZD567PF1A", sealSecret: "63QRMM2XM7EB" },
  { unitId: 4, serial: "0XMRF9BQW7B9VVYKXY8F", sealSecret: "HNVWG278MFMQ" },
  { unitId: 5, serial: "S7NY46QGMKAFTSCK1K0N", sealSecret: "JRWNQJ99JMME" },
  { unitId: 6, serial: "5X2169CMC620WYKJC7ZN", sealSecret: "3YCNHXTV4950" },
  { unitId: 7, serial: "Y3S8B9648EN1GYA8NPNB", sealSecret: "D5CB3SQGTCM7" },
  { unitId: 8, serial: "B8N2XJDCMN47KM60M55A", sealSecret: "D3TCM0DS4KG7" },
  { unitId: 9, serial: "Y3HJ0SH82SMS3JNW2KXG", sealSecret: "XBF837P8DF5V" },
  { unitId: 10, serial: "3VWXZ4BDNP3VKYDMZV6P", sealSecret: "M71ZJVF2Y8VB" },
];

function computeSealVerifier(unitId: number | string, normalizedSecret: string, version = "v1"): string {
  const pepper = process.env.SEAL_PEPPER || "pharmatree-tamper-seal-secret-pepper-v1";
  const hmac = crypto.createHmac("sha256", pepper);
  hmac.update(`${unitId}:${normalizedSecret}`);
  return `${version}:${hmac.digest("hex")}`;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) {
    console.error("❌ ERROR: DATABASE_URL is not set. Please set DATABASE_URL to seed Neon PostgreSQL.");
    process.exit(1);
  }

  const contractAddress = (
    process.env.SEPOLIA_CONTRACT_ADDRESS ||
    process.env.NEXT_PUBLIC_PHARMA_TREE_CONTRACT ||
    "0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345"
  ).toLowerCase();

  console.log(`Connecting to database to seed seals for contract: ${contractAddress}...`);
  const { Pool, neonConfig } = await import("@neondatabase/serverless");
  // @ts-ignore
  const ws: any = await import("ws");
  neonConfig.webSocketConstructor = ws.default || ws;
  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  try {
    // Ensure table and contract_address column exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS seal_secrets (
        unit_id VARCHAR(64) PRIMARY KEY,
        contract_address VARCHAR(42),
        verifier VARCHAR(128) NOT NULL,
        scheme INTEGER NOT NULL DEFAULT 1,
        state VARCHAR(32) DEFAULT 'SEALED',
        failed_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP WITH TIME ZONE,
        consumed_at TIMESTAMP WITH TIME ZONE
      );
      ALTER TABLE seal_secrets ADD COLUMN IF NOT EXISTS contract_address VARCHAR(42);
    `);

    for (const unit of DEMO_UNITS) {
      const verifier = computeSealVerifier(unit.unitId, unit.sealSecret, "v1");
      await client.query(
        `INSERT INTO seal_secrets (unit_id, contract_address, verifier, scheme, state, failed_attempts)
         VALUES ($1, $2, $3, 1, 'SEALED', 0)
         ON CONFLICT (unit_id) DO UPDATE SET
           contract_address = EXCLUDED.contract_address,
           verifier = EXCLUDED.verifier,
           scheme = EXCLUDED.scheme;`,
        [String(unit.unitId), contractAddress, verifier]
      );
      console.log(`✅ Seeded seal verifier for Unit #${unit.unitId}`);
    }

    console.log("\n🎉 Successfully seeded all 10 tamper seal verifiers into Neon database!");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
