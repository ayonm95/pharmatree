# PharmaTree Frontend Dashboard & Verification Portal

A production-grade Web3 supply-chain management dashboard and public verification engine for **PharmaTree**. Built with **Next.js 16 (App Router)**, **React 19**, **Ethers.js v6**, and **Turbopack**.

---

## 🌟 Features

- **Automated MetaMask Detection & Role Adaptation**: Dynamically switches UI capabilities between **Admin**, **Manufacturer**, **Handler**, and **Consumer** based on active on-chain roles.
- **Resilient Multi-Endpoint Fallback RPC (`rpc.ts`)**: Built-in RPC failover engine with automatic round-robin, exponential backoff, and recovery on HTTP 429 rate limits across public Sepolia nodes (Tenderly, PublicNode, 1RPC, Sepolia.org).
- **Two-Way Rejection Flow & Stock Restoration**:
  - **Rejecter Account**: Recent Activity tab displays **`Rejected by You`** badge, sender address, and rejection timestamp.
  - **Sender Account**: Inventory tab directly tags rejected partitions with **`Rejected by 0x...`**, sets status to `Returned to sender`, and automatically restores the rejected quantity to active stock counts (`70/100 (30 active, 40 rejected returned)`).
- **Public Provenance Verification Portal (`/verify`)**: Zero-wallet consumer verification engine. Scan a QR code or enter a Unit ID to inspect manufacturer credentials, container level, and the complete chronological custody audit trail.
- **In-App QR Code Generator**: Downloadable and printable PNG QR codes for any medicine unit or batch directly from inventory tiles.
- **Reactive Stock Charts & Lineage Tracking**: Visualizes batch partitions (`#1.1`, `#1.2`) with retained remainders and status badges.

---

## 🧭 Routes & Pages

| Route | View Mode | Description |
| :--- | :--- | :--- |
| `/` | `overview` | High-level stock metrics, reactive donut chart, quarterly tallies, and partition branches |
| `/create` | `create` | Form for authorized manufacturers to mint root medicine units with packaging level and batch quantity |
| `/admin` | `admin` | Cryptographic role granting panel for contract administrators |
| `/transfers` | `transfers` | Custody handshake controls (Initiate, Accept, Reject, Dispense/Sell) and Recent Activity feed |
| `/inventory` | `inventory` | Full medicine lineage view with expandable partition hierarchy and transfer history logs |
| `/verify` | `verify` | Public consumer portal for verifying medicine authenticity and on-chain custody timelines |

---

## ⚙️ Environment Configuration (`frontend/.env.local`)

```env
NEXT_PUBLIC_PHARMA_TREE_CONTRACT=0x2bAE15834463a657F68673135B8deCd39EF33044
NEXT_PUBLIC_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
NEXT_PUBLIC_CHAIN_ID=11155111
NEXT_PUBLIC_DEPLOYMENT_BLOCK=11683269
```

---

## 🚀 Getting Started

From the `frontend` directory:

```bash
# Install dependencies
npm install

# Start development server with Turbopack
npm run dev

# Build for production
npm run build
```

Open [http://localhost:3000](http://localhost:3000) in your browser.
