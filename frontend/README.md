# PharmaTree Frontend Dashboard & Verification Portal

A production-grade Web3 supply-chain management dashboard and public verification engine for **PharmaTree**. Built with **Next.js 16 (App Router)**, **React 19**, **Ethers.js v6**, **Vitest**, and **Turbopack**.

---

## 🌟 Features

- **Automated MetaMask Detection & Role Adaptation**: Dynamically switches UI capabilities between **Admin**, **Manufacturer**, **Handler**, **Dispenser**, and **Consumer** based on active on-chain roles.
- **Vendor POS Scanner Terminal (`/pos`)**: High-throughput kiosk scanner for retail dispensaries. Features rapid keyboard checkout (`Spacebar` / `Enter`), collapsible tamper-seal inspection, dual camera/USB-wedge barcode listeners, gasless relayer execution, Web Audio feedback, child unit QR label emission for partial sales, and quarantine incident telemetry.
- **GS1 Digital Link URI Resolver (`/01/{GTIN}/10/{Lot}/21/{Serial}`)**: Full GS1 compliance with GTIN-14 Modulo 10 Luhn check digit verification and 2D DataMatrix barcode generation.
- **Dual-Scheme Tamper Seals (Tier 5)**: Scheme 1 Crockford Base32 HMAC-SHA256 verifiers with 24-hr anti-DoS cooldown lockout and IP subnet masking.
- **Resilient Multi-Endpoint Fallback RPC (`rpc.ts`)**: Built-in RPC failover engine with automatic round-robin, exponential backoff, and recovery on HTTP 429 rate limits across public Sepolia nodes.
- **Two-Way Rejection Flow & Stock Restoration**:
  - **Rejecter Account**: Displays **`Rejected by You`** badge, sender address, and rejection timestamp.
  - **Sender Account**: Inventory directly tags rejected units with **`Rejected by 0x...`**, and QA clearance restores active stock.
- **Public Provenance Verification Portal (`/verify`)**: Zero-wallet consumer verification engine. Scan a QR code or enter a Unit ID to inspect manufacturer credentials, packaging level, and the complete chronological custody audit trail.
- **Pure Client Utilities (`lib/serial.ts`)**: Zero-dependency client serial normalizer and Crockford Base32 generator safe from Node.js server dependencies.

---

## 🧭 Routes & Pages

| Route | View Mode | Description |
| :--- | :--- | :--- |
| `/` | `overview` | High-level stock metrics, reactive donut chart, quarterly tallies, and partition branches |
| `/create` | `create` | Form for authorized manufacturers to mint root medicine units with packaging level, batch quantity, serial hash, and expiry |
| `/admin` | `admin` | Cryptographic role granting and revocation panel for contract administrators |
| `/transfers` | `transfers` | Custody handshake controls (Initiate, Accept, Reject, Dispense/Sell) and Recent Activity feed |
| `/inventory` | `inventory` | Full medicine lineage view with expandable partition hierarchy and transfer history logs |
| `/pos` | `pos` | High-throughput vendor retail point-of-sale scanner terminal with gasless meta-transactions |
| `/verify` | `verify` | Public consumer portal for verifying medicine authenticity and on-chain custody timelines |
| `/01/[gtin]/10/[lot]/21/[serial]` | `gs1` | GS1 Digital Link standard endpoint resolving packaging barcodes to provenance records |

---

## ⚙️ Environment Configuration (`frontend/.env.local`)

```env
NEXT_PUBLIC_PHARMA_TREE_CONTRACT=0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345
NEXT_PUBLIC_TRUSTED_FORWARDER=0x2d24b5b481d0981AE7904790e9d8BF4c162b6c8c
NEXT_PUBLIC_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
NEXT_PUBLIC_CHAIN_ID=11155111
NEXT_PUBLIC_DEPLOYMENT_BLOCK=12033849
RELAYER_PRIVATE_KEY=your_unprivileged_relayer_private_key
DATABASE_URL=postgresql://user:password@endpoint.neon.tech/neondb?sslmode=require
SEAL_PEPPER=your-server-side-seal-pepper
TRUSTED_PROXY=vercel
DEMO_SANDBOX_ENABLED=false
ALLOW_LEGACY_SEALS=false
```

---

## 🧪 Testing (62 Automated Tests)

Run frontend unit and integration tests with Vitest:

```bash
npm test
```

Covers:
- `serial.test.ts`: Crockford Base32 normalization and CSPRNG high-entropy client serial generation.
- `sealVerifier.test.ts`: Scheme 1 Crockford Base32 HMAC-SHA256, 24-hr lockout, and anti-DoS IP isolation.
- `tierEvaluator.test.ts`: 5-tier anti-counterfeiting verification rules, serial matching, and prescription child detection.
- `rateLimit.test.ts`: Sliding-window distributed rate limiting and IPv6 subnet masking.
- `tenantAuth.test.ts`: Header authentication, API key verification, and fail-closed quotas.
- `posSellApi.test.ts`: Idempotency keys, input validation, and POS sell API contracts.

---

## 🚀 Getting Started

From the `frontend` directory:

```bash
# Install dependencies
npm install

# Start development server with Turbopack
npm run dev

# Run unit tests
npm test

# Build for production
npm run build
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

