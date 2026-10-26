# PharmaTree Smart Contracts & Backend

The smart contract foundation of the **PharmaTree** decentralized pharmaceutical tracking network. Built with **Solidity 0.8.20**, **Hardhat**, and **Ethers.js v6**.

---

## 📍 Live Deployment (Ethereum Sepolia)

| Parameter | Value |
| :--- | :--- |
| **Network** | Ethereum Sepolia Testnet |
| **Chain ID** | `11155111` |
| **Contract Address** | [`0x7c40b82B39346A56Ba69df52A37eBBDfF541b198`](https://sepolia.etherscan.io/address/0x7c40b82B39346A56Ba69df52A37eBBDfF541b198) |
| **Deployment Block** | `11995000` |
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
  - `rejectTransfer(unitId)`: Authorized recipient rejects inbound shipment, transitioning state to `Rejected`.
  - `reclaimRejectedUnit(unitId)`: Current owner reclaims rejected stock.
- **Dispensing & Sale Detachment**:
  - `sellQuantity(unitId, quantity)`: Splits stock and marks partial dispensing on-chain with updated metadata.
  - `markAsSold(unitId)`: Finalizes complete unit sale, permanently locking it against subsequent transfers.

---

## 🧪 Testing Suite (25 Test Cases)

Run the Chai/Hardhat test suite:

```bash
npm test
```

All 25 comprehensive test scenarios validate:
1. **Admin & Role Authorization**: Role assignment, admin initialization, and unauthorized access reverts.
2. **Hierarchical Creation**: Root unit creation, parent/root lineage tracking, batch packing limits, and hierarchy level enforcement.
3. **Partial Transfers**: Sender remainder retention and child unit detachment.
4. **Two-Party Handshake**: Mutual acceptance, unauthorized recipient prevention, wrong-caller reverts, transfer cancellation, and rejection handling.
5. **Final Sale & Detachment**: Complete and partial sales (`sellQuantity`), quantity conservation, and transfer prevention on sold stock.

---

## 🚀 Deployment & Scripts

```bash
# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to Sepolia testnet
npx hardhat run scripts/deploy-sepolia.ts --network sepolia

# Run E2E Sepolia invariant verification suite
npx hardhat run scripts/e2e-sepolia-validation.ts --network sepolia
```
