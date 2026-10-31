// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract PharmaTree is AccessControl, ERC2771Context {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant HANDLER_ROLE = keccak256("HANDLER_ROLE");

    address public admin;

    enum UnitLevel { Container, Shipment, Batch, Box, IndividualItem }
    enum Status { Active, PendingTransfer, Sold, Rejected }

    struct Unit {
        uint256 parentId;
        uint256 rootId;
        UnitLevel level;
        address manufacturer;
        address currentOwner;
        address pendingReceiver;
        Status status;
        uint256 quantity;
        string metadata;
    }

    mapping(uint256 => Unit) public units;
    mapping(uint256 => uint256[]) public children;
    uint256 public unitCounter;

    mapping(address => bool) public isManufacturer;
    mapping(address => bool) public isHandler;

    event UnitCreated(uint256 indexed id, uint256 indexed parentId, UnitLevel level, address indexed owner);
    event TransferInitiated(uint256 indexed id, address indexed from, address indexed to);
    event TransferCompleted(uint256 indexed id, address indexed from, address indexed to);
    event TransferRejected(uint256 indexed id, address indexed from, address indexed rejectedBy);
    event TransferCancelled(uint256 indexed id, address indexed cancelledBy);
    event UnitReclaimed(uint256 indexed id, address indexed reclaimedBy);
    event UnitSold(uint256 indexed id, address indexed soldBy);

    modifier onlyAdmin() {
        require(hasRole(DEFAULT_ADMIN_ROLE, _msgSender()), "Not admin");
        _;
    }

    modifier onlyCurrentOwner(uint256 _id) {
        require(units[_id].currentOwner == _msgSender(), "Not the current owner");
        _;
    }

    constructor(address trustedForwarder_) ERC2771Context(trustedForwarder_) {
        address deployer = _msgSender();
        admin = deployer;
        _grantRole(DEFAULT_ADMIN_ROLE, deployer);
        _grantRole(MANUFACTURER_ROLE, deployer);
        isManufacturer[deployer] = true;
    }

    function addManufacturer(address _mfr) external onlyAdmin {
        require(_mfr != address(0), "Zero address invalid");
        grantRole(MANUFACTURER_ROLE, _mfr);
        isManufacturer[_mfr] = true;
    }

    function addHandler(address _handler) external onlyAdmin {
        require(_handler != address(0), "Zero address invalid");
        grantRole(HANDLER_ROLE, _handler);
        isHandler[_handler] = true;
    }

    function removeManufacturer(address _mfr) external onlyAdmin {
        revokeRole(MANUFACTURER_ROLE, _mfr);
        isManufacturer[_mfr] = false;
    }

    function removeHandler(address _handler) external onlyAdmin {
        revokeRole(HANDLER_ROLE, _handler);
        isHandler[_handler] = false;
    }

    function createRootUnit(UnitLevel _level, string calldata _metadata, uint256 _quantity) external returns (uint256) {
        return _createRootUnit(_level, _metadata, _quantity);
    }

    function _createRootUnit(UnitLevel _level, string calldata _metadata, uint256 _quantity) internal returns (uint256) {
        require(hasRole(MANUFACTURER_ROLE, _msgSender()), "Only manufacturers can create root units");
        require(_quantity > 0, "Quantity must be greater than zero");
        return _createUnit(0, 0, _level, _msgSender(), _msgSender(), _metadata, _quantity);
    }

    function createChildUnits(uint256 _parentId, UnitLevel _childLevel, string calldata _metadata, uint256 _count) external {
        require(_parentId > 0 && _parentId <= unitCounter, "Parent unit does not exist");
        require(units[_parentId].currentOwner == _msgSender(), "Must own the parent to pack children");
        require(units[_parentId].status == Status.Active, "Parent unit cannot be in transit or sold");
        require(_count > 0, "Count must be greater than zero");
        require(_count <= 250, "Batch count exceeds limit");
        require(uint8(_childLevel) > uint8(units[_parentId].level), "Child level must be strictly lower in hierarchy");

        address originalMfr = units[_parentId].manufacturer;
        uint256 rootId = units[_parentId].rootId == 0 ? _parentId : units[_parentId].rootId;

        for (uint256 i = 0; i < _count; i++) {
            uint256 childId = _createUnit(_parentId, rootId, _childLevel, originalMfr, _msgSender(), _metadata, 1);
            children[_parentId].push(childId);
        }
    }

    function _createUnit(
        uint256 _parentId,
        uint256 _rootId,
        UnitLevel _level,
        address _manufacturer,
        address _owner,
        string memory _metadata,
        uint256 _quantity
    ) internal returns (uint256) {
        unitCounter++;
        uint256 unitId = unitCounter;

        units[unitId] = Unit({
            parentId: _parentId,
            rootId: _rootId,
            level: _level,
            manufacturer: _manufacturer,
            currentOwner: _owner,
            pendingReceiver: address(0),
            status: Status.Active,
            quantity: _quantity,
            metadata: _metadata
        });

        emit UnitCreated(unitId, _parentId, _level, _owner);
        return unitId;
    }

    function initiateTransfer(uint256 _id, address _receiver) external returns (uint256) {
        return _initiateTransfer(_id, _receiver, units[_id].quantity);
    }

    function initiatePartialTransfer(uint256 _id, address _receiver, uint256 _quantity) external returns (uint256) {
        return _initiateTransfer(_id, _receiver, _quantity);
    }

    function _formatMetadata(string memory _originalMetadata, uint256 _newQuantity) internal pure returns (string memory) {
        bytes memory strBytes = bytes(_originalMetadata);
        uint256 commaIndex = strBytes.length;
        for (uint256 i = 0; i < strBytes.length; i++) {
            if (strBytes[i] == ",") {
                commaIndex = i;
                break;
            }
        }
        bytes memory baseNameBytes = new bytes(commaIndex);
        for (uint256 j = 0; j < commaIndex; j++) {
            baseNameBytes[j] = strBytes[j];
        }
        return string.concat(string(baseNameBytes), ", ", Strings.toString(_newQuantity), " tablets");
    }

    function _initiateTransfer(uint256 _id, address _receiver, uint256 _quantity) internal onlyCurrentOwner(_id) returns (uint256) {
        require(units[_id].status == Status.Active, "Unit not active");
        require(hasRole(MANUFACTURER_ROLE, _receiver) || hasRole(HANDLER_ROLE, _receiver), "Receiver is not authorized");
        require(_quantity > 0 && _quantity <= units[_id].quantity, "Invalid transfer quantity");

        uint256 transferId = _id;
        if (_quantity < units[_id].quantity) {
            uint256 remainingQuantity = units[_id].quantity - _quantity;
            string memory baseMeta = units[_id].metadata;
            units[_id].quantity = remainingQuantity;
            units[_id].metadata = _formatMetadata(baseMeta, remainingQuantity);

            string memory childMetadata = _formatMetadata(baseMeta, _quantity);
            transferId = _createUnit(
                _id,
                units[_id].rootId == 0 ? _id : units[_id].rootId,
                units[_id].level,
                units[_id].manufacturer,
                _msgSender(),
                childMetadata,
                _quantity
            );
            children[_id].push(transferId);
        }

        units[transferId].pendingReceiver = _receiver;
        units[transferId].status = Status.PendingTransfer;

        emit TransferInitiated(transferId, _msgSender(), _receiver);
        return transferId;
    }

    function acceptTransfer(uint256 _id) external {
        require(units[_id].status == Status.PendingTransfer, "No transfer pending");
        require(units[_id].pendingReceiver == _msgSender(), "You are not the pending receiver");

        address previousOwner = units[_id].currentOwner;
        units[_id].currentOwner = _msgSender();
        units[_id].pendingReceiver = address(0);
        units[_id].status = Status.Active;

        emit TransferCompleted(_id, previousOwner, _msgSender());
    }

    function rejectTransfer(uint256 _id) external {
        require(units[_id].status == Status.PendingTransfer, "No transfer pending");
        require(units[_id].pendingReceiver == _msgSender(), "You are not the pending receiver");

        units[_id].pendingReceiver = address(0);
        units[_id].status = Status.Rejected;

        emit TransferRejected(_id, units[_id].currentOwner, _msgSender());
    }

    function cancelTransfer(uint256 _id) external onlyCurrentOwner(_id) {
        require(units[_id].status == Status.PendingTransfer, "No transfer pending");

        units[_id].pendingReceiver = address(0);
        units[_id].status = Status.Active;

        emit TransferCancelled(_id, _msgSender());
    }

    function reclaimRejectedUnit(uint256 _id) external onlyCurrentOwner(_id) {
        require(units[_id].status == Status.Rejected, "Unit is not rejected");

        units[_id].status = Status.Active;

        emit UnitReclaimed(_id, _msgSender());
    }

    function sellQuantity(uint256 _id, uint256 _quantity) public onlyCurrentOwner(_id) returns (uint256) {
        require(units[_id].status == Status.Active, "Unit is not active");
        require(_quantity > 0 && _quantity <= units[_id].quantity, "Invalid sale quantity");

        uint256 soldUnitId = _id;
        if (_quantity < units[_id].quantity) {
            uint256 remainingQuantity = units[_id].quantity - _quantity;
            string memory baseMeta = units[_id].metadata;
            units[_id].quantity = remainingQuantity;
            units[_id].metadata = _formatMetadata(baseMeta, remainingQuantity);

            string memory soldMetadata = _formatMetadata(baseMeta, _quantity);
            soldUnitId = _createUnit(
                _id,
                units[_id].rootId == 0 ? _id : units[_id].rootId,
                units[_id].level,
                units[_id].manufacturer,
                _msgSender(),
                soldMetadata,
                _quantity
            );
            children[_id].push(soldUnitId);
        }

        units[soldUnitId].status = Status.Sold;
        units[soldUnitId].pendingReceiver = address(0);

        emit UnitSold(soldUnitId, _msgSender());
        return soldUnitId;
    }

    function markAsSold(uint256 _id) external onlyCurrentOwner(_id) {
        sellQuantity(_id, units[_id].quantity);
    }

    function getChildren(uint256 _parentId) external view returns (uint256[] memory) {
        return children[_parentId];
    }

    function getUnitDetails(uint256 _id) external view returns (Unit memory) {
        require(_id > 0 && _id <= unitCounter, "Unit does not exist");
        return units[_id];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _msgSender()
        internal
        view
        virtual
        override(Context, ERC2771Context)
        returns (address)
    {
        return ERC2771Context._msgSender();
    }

    function _msgData()
        internal
        view
        virtual
        override(Context, ERC2771Context)
        returns (bytes calldata)
    {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        virtual
        override(Context, ERC2771Context)
        returns (uint256)
    {
        return ERC2771Context._contextSuffixLength();
    }
}
