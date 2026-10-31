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
  - `clearRejected(unitId, evidenceHash)`: Authorized QA auditor (`QA_ROLE`) clears quarantine back to `Active` after formal inspection with cryptographic audit evidence.
- **Dispensing & Sale Detachment**:
  - `sellQuantity(unitId, quantity)`: Splits stock and marks partial dispensing on-chain (`DISPENSER_ROLE` required).
  - `markAsSold(unitId)`: Finalizes complete unit sale, permanently locking it against subsequent transfers (`DISPENSER_ROLE` required).

---

## 🧪 Testing Suite (70 Automated Tests)

Run the Chai/Hardhat test suite:

```bash
npm test
```

All 70 comprehensive test scenarios validate:
1. **Admin & Role Authorization**: Role assignment, admin initialization, role revocation, and strict segregation of `HANDLER_ROLE`, `DISPENSER_ROLE`, and `QA_ROLE`.
2. **Hierarchical Creation**: Root unit creation, parent/root lineage tracking, batch packing limits, hierarchy level enforcement, and unguessable `serialHash` registration.
3. **Partial Transfers**: Sender remainder retention, child unit detachment, and mass conservation ($\sum Q$).
4. **Two-Party Handshake & Quarantine**: Mutual acceptance, unauthorized recipient prevention, wrong-caller reverts, transfer cancellation, transit rejection, and role-gated QA audit clearance (`clearRejected`).
5. **Dispensing, Expiry & Recalls**: Retail dispensing validation, expiration blocking (`expiry`), batch-wide recall freezing (`recalledRoots`), and transfer prevention on sold stock.
6. **EIP-712 Meta-Transactions & Relayer Decoupling**: Gasless forwarder execution with an unprivileged relayer holding zero contract roles.
7. **Randomized Property Tests**: 35 randomized supply-chain operations verifying strict inventory mass conservation under concurrency.

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
