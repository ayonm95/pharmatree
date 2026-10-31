import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../frontend/.env.local") });

async function resetDatabase(options?: { authorized?: boolean }) {
  console.log("--- Resetting Database State ---");
  const isAuthorized = options?.authorized || process.argv.includes("--reset-db");
  const expectedChain = process.env.SEPOLIA_CHAIN_ID || "11155111";
  const hasChainConfirmation = process.argv.includes(`--confirm-chain=${expectedChain}`) || options?.authorized;

  if (!isAuthorized || !hasChainConfirmation) {
    console.error(
      "❌ Destructive action aborted! To authorize database reset, you must explicitly pass:\n" +
      `   npx ts-node scripts/reset-db.ts --reset-db --confirm-chain=${expectedChain}\n` +
      "This guard prevents accidental data erasure of live production databases."
    );
    if (require.main === module) process.exit(1);
    return;
  }
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (dbUrl) {
    try {
      // Dynamic import to avoid build errors if serverless driver is not in backend dependencies
      const { Pool } = await import("@neondatabase/serverless");
      const pool = new Pool({ connectionString: dbUrl });
      const client = await pool.connect();
      try {
        console.log("Truncating Neon database unit-specific tables...");
        await client.query(`
          TRUNCATE TABLE 
            units, 
            unit_events, 
            scans, 
            scan_logs, 
            seal_secrets, 
            client_seal_locks, 
            incidents, 
            sales, 
            used_reset_nonces 
          CASCADE;
        `);
        console.log("✅ Neon database tables truncated successfully.");
      } finally {
        client.release();
        await pool.end();
      }
    } catch (err: any) {
      console.warn("Neon truncate notice:", err.message);
    }
  }

  // Clear local file storage
  const localDirs = [
    path.resolve(__dirname, "../../frontend/.data"),
    path.resolve(__dirname, "../../.data"),
    path.resolve(__dirname, "../.data"),
    "/tmp/.pharmatree-data",
  ];

  for (const dir of localDirs) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`✅ Cleared local storage directory: ${dir}`);
      } catch (err: any) {
        console.warn(`Could not clear directory ${dir}:`, err.message);
      }
    }
  }

  console.log("--- Database Reset Complete ---\n");
}

if (require.main === module) {
  resetDatabase().catch((err) => {
    console.error("Failed to reset database:", err);
    process.exit(1);
  });
}

export { resetDatabase };
