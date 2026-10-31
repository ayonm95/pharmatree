// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/**
 * @title PharmaTreeForwarder
 * @dev OpenZeppelin ERC2771Forwarder implementation for PharmaTree meta-transactions.
 * Enables gasless / relayed transactions signed via EIP-712 by authorized actors.
 */
contract PharmaTreeForwarder is ERC2771Forwarder {
    constructor(string memory name) ERC2771Forwarder(name) {}
}
