# PharmaTree Smart Contracts & Backend

The smart contract foundation of the **PharmaTree** decentralized pharmaceutical tracking network. Built with **Solidity 0.8.20**, **Hardhat**, and **Ethers.js v6**.

---

## 📍 Live Deployment (Ethereum Sepolia)

| Parameter | Value |
| :--- | :--- |
| **Network** | Ethereum Sepolia Testnet |
| **Chain ID** | `11155111` |
| **Contract Address** | [`0x2bAE15834463a657F68673135B8deCd39EF33044`](https://sepolia.etherscan.io/address/0x2bAE15834463a657F68673135B8deCd39EF33044) |
| **Deployment Block** | `11683269` |
| **Compiler Version** | `v0.8.20+commit.a1b79de6` |

---

## 🏛️ Smart Contract Architecture (`contracts/PharmaTree.sol`)

- **Role-Based Access Control (RBAC)**:
  - `Admin`: Assigns and revokes `Manufacturer` and `Handler` authorizations.
  - `Manufacturer`: Authorized to create root pharmaceutical units with cryptographic provenance.
  - `Handler`: Authorized logistics and healthcare entities (Distributors, Wholesalers, Pharmacies) allowed to participate in custody handshakes.
- **Hierarchical Packaging Lineage**:
  `Container (0) ➔ Shipment (1) ➔ Batch (2) ➔ Box (3) ➔ IndividualItem (4)`
- **Two-Party Handshake & Custody Transfer**:
  - `initiateTransfer(unitId, receiver)`: Transfers full unit quantity to pending state.
  - `initiatePartialTransfer(unitId, receiver, quantity)`: Splits available quantity, preserving sender remainder and minting a child unit with inherited parent/root lineage.
  - `acceptTransfer(unitId)`: Authorized recipient accepts custody, transitioning state to `Active`.
  - `rejectTransfer(unitId)`: Authorized recipient rejects inbound shipment, clearing pending receiver back to `address(0)` while retaining sender ownership and restoring available inventory.
- **Dispensing & Sale Detachment**:
  - `sellQuantity(unitId, quantity)`: Splits stock and marks partial dispensing on-chain with updated metadata.
  - `markAsSold(unitId)`: Finalizes complete unit sale, permanently locking it against subsequent transfers.

---

## 🧪 Testing Suite (21 Test Cases)

Run the Chai/Hardhat test suite:

```bash
npm test
```

All 21 comprehensive test scenarios validate:
1. **Admin & Role Authorization**: Role assignment, admin initialization, and unauthorized access reverts.
2. **Hierarchical Creation**: Root unit creation, parent/root lineage tracking, and permission checks.
3. **Partial Transfers**: Sender remainder retention and child unit detachment.
4. **Two-Party Handshake**: Mutual acceptance, unauthorized recipient prevention, and wrong-caller reverts.
5. **Transfer Rejection**: Recipient rejection capability, state transition to `Status.Rejected (3)`, and custody retention.
6. **Dispensing & Sale**: `sellQuantity` partial splitting, `markAsSold` complete sales, zero-quantity checks, and over-quantity reverts.

---

## 🚀 Deployment & Management Scripts

```bash
# Compile contracts
npm run compile

# Deploy to Sepolia testnet
npm run deploy:sepolia

# Deploy a fresh manufacturer contract and sync environment files
npm run deploy:fresh-manufacturer

# Run end-to-end Sepolia validation flow
npm run verify:sepolia

# Grant roles to distributor / handler accounts
npx hardhat run scripts/grant-roles.ts --network sepolia
```

---

## ⚙️ Environment Configuration (`backend/.env`)

```env
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
SEPOLIA_PRIVATE_KEY_MANUFACTURER=0x...
SEPOLIA_PRIVATE_KEY_DISTRIBUTOR=0x...
SEPOLIA_CHAIN_ID=11155111
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY
SEPOLIA_CONTRACT_ADDRESS=0x2bAE15834463a657F68673135B8deCd39EF33044
```
