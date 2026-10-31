// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract PharmaTree is AccessControl, ERC2771Context {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant HANDLER_ROLE = keccak256("HANDLER_ROLE");
    bytes32 public constant DISPENSER_ROLE = keccak256("DISPENSER_ROLE");
    bytes32 public constant QA_ROLE = keccak256("QA_ROLE");

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
        bytes32 serialHash;
        uint256 expiry;
    }

    mapping(uint256 => Unit) public units;
    mapping(uint256 => uint256[]) public children;
    uint256 public unitCounter;

    mapping(uint256 => bool) public recalledRoots;

    mapping(address => bool) public isManufacturer;
    mapping(address => bool) public isHandler;
    mapping(address => bool) public isDispenser;
    mapping(address => bool) public isQA;

    event UnitCreated(uint256 indexed id, uint256 indexed parentId, UnitLevel level, address indexed owner);
    event TransferInitiated(uint256 indexed id, address indexed from, address indexed to);
    event TransferCompleted(uint256 indexed id, address indexed from, address indexed to);
    event TransferRejected(uint256 indexed id, address indexed from, address indexed rejectedBy);
    event TransferCancelled(uint256 indexed id, address indexed cancelledBy);
    event RejectedCleared(uint256 indexed id, address indexed clearedBy, bytes32 evidenceHash);
    event UnitSold(uint256 indexed id, address indexed soldBy);
    event RootRecalled(uint256 indexed rootId, address indexed recalledBy);
    event RootUnrecalled(uint256 indexed rootId, address indexed unrecalledBy);

    modifier onlyAdmin() {
        require(hasRole(DEFAULT_ADMIN_ROLE, _msgSender()), "Not admin");
        _;
    }

    modifier onlyCurrentOwner(uint256 _id) {
        require(units[_id].currentOwner == _msgSender(), "Not the current owner");
        _;
    }

    modifier onlyDispenser() {
        require(
            hasRole(DISPENSER_ROLE, _msgSender()) || hasRole(DEFAULT_ADMIN_ROLE, _msgSender()),
            "Caller is not an authorized dispenser"
        );
        _;
    }

    modifier onlyQA() {
        require(
            hasRole(QA_ROLE, _msgSender()) || hasRole(DEFAULT_ADMIN_ROLE, _msgSender()),
            "Caller is not authorized QA"
        );
        _;
    }

    modifier dispensable(uint256 _id) {
        require(units[_id].status == Status.Active, "Unit is not active");
        uint256 rId = units[_id].rootId == 0 ? _id : units[_id].rootId;
        require(!recalledRoots[rId], "Batch is recalled");
        if (units[_id].expiry > 0) {
            require(block.timestamp <= units[_id].expiry, "Unit is expired");
        }
        _;
    }

    constructor(address trustedForwarder_) ERC2771Context(trustedForwarder_) {
        address deployer = _msgSender();
        admin = deployer;
        _grantRole(DEFAULT_ADMIN_ROLE, deployer);
        _grantRole(MANUFACTURER_ROLE, deployer);
        _grantRole(HANDLER_ROLE, deployer);
        _grantRole(DISPENSER_ROLE, deployer);
        _grantRole(QA_ROLE, deployer);
        isManufacturer[deployer] = true;
        isHandler[deployer] = true;
        isDispenser[deployer] = true;
        isQA[deployer] = true;
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

    function addDispenser(address _dispenser) external onlyAdmin {
        require(_dispenser != address(0), "Zero address invalid");
        grantRole(DISPENSER_ROLE, _dispenser);
        isDispenser[_dispenser] = true;
    }

    function addQA(address _qa) external onlyAdmin {
        require(_qa != address(0), "Zero address invalid");
        grantRole(QA_ROLE, _qa);
        isQA[_qa] = true;
    }

    function removeManufacturer(address _mfr) external onlyAdmin {
        revokeRole(MANUFACTURER_ROLE, _mfr);
        isManufacturer[_mfr] = false;
    }

    function removeHandler(address _handler) external onlyAdmin {
        revokeRole(HANDLER_ROLE, _handler);
        isHandler[_handler] = false;
    }

    function removeDispenser(address _dispenser) external onlyAdmin {
        revokeRole(DISPENSER_ROLE, _dispenser);
        isDispenser[_dispenser] = false;
    }

    function removeQA(address _qa) external onlyAdmin {
        revokeRole(QA_ROLE, _qa);
        isQA[_qa] = false;
    }

    function recallRoot(uint256 _rootId) external {
        require(
            hasRole(MANUFACTURER_ROLE, _msgSender()) ||
            hasRole(QA_ROLE, _msgSender()) ||
            hasRole(DEFAULT_ADMIN_ROLE, _msgSender()),
            "Not authorized to recall"
        );
        require(_rootId > 0 && _rootId <= unitCounter, "Invalid root ID");
        recalledRoots[_rootId] = true;
        emit RootRecalled(_rootId, _msgSender());
    }

    function unrecallRoot(uint256 _rootId) external {
        require(
            hasRole(MANUFACTURER_ROLE, _msgSender()) ||
            hasRole(QA_ROLE, _msgSender()) ||
            hasRole(DEFAULT_ADMIN_ROLE, _msgSender()),
            "Not authorized to unrecall"
        );
        require(_rootId > 0 && _rootId <= unitCounter, "Invalid root ID");
        recalledRoots[_rootId] = false;
        emit RootUnrecalled(_rootId, _msgSender());
    }

    function createRootUnit(UnitLevel _level, string calldata _metadata, uint256 _quantity) external returns (uint256) {
        return _createRootUnit(_level, _metadata, _quantity, bytes32(0), 0);
    }

    function createRootUnitWithSerial(
        UnitLevel _level,
        string calldata _metadata,
        uint256 _quantity,
        string calldata _serial,
        uint256 _expiry
    ) external returns (uint256) {
        bytes32 sHash = bytes(_serial).length > 0 ? keccak256(bytes(_serial)) : bytes32(0);
        return _createRootUnit(_level, _metadata, _quantity, sHash, _expiry);
    }

    function _createRootUnit(
        UnitLevel _level,
        string calldata _metadata,
        uint256 _quantity,
        bytes32 _serialHash,
        uint256 _expiry
    ) internal returns (uint256) {
        require(hasRole(MANUFACTURER_ROLE, _msgSender()), "Only manufacturers can create root units");
        require(_quantity > 0, "Quantity must be greater than zero");
        return _createUnit(0, 0, _level, _msgSender(), _msgSender(), _metadata, _quantity, _serialHash, _expiry);
    }

    function createChildUnits(uint256 _parentId, UnitLevel _childLevel, string calldata _metadata, uint256 _count) external {
        _createChildUnitsBatch(_parentId, _childLevel, _metadata, _count, bytes32(0));
    }

    function createChildUnitsWithSerial(
        uint256 _parentId,
        UnitLevel _childLevel,
        string calldata _metadata,
        uint256 _count,
        string calldata _serial
    ) external {
        bytes32 sHash = bytes(_serial).length > 0 ? keccak256(bytes(_serial)) : bytes32(0);
        _createChildUnitsBatch(_parentId, _childLevel, _metadata, _count, sHash);
    }

    function _createChildUnitsBatch(
        uint256 _parentId,
        UnitLevel _childLevel,
        string calldata _metadata,
        uint256 _count,
        bytes32 _serialHash
    ) internal {
        require(_parentId > 0 && _parentId <= unitCounter, "Parent unit does not exist");
        require(units[_parentId].currentOwner == _msgSender(), "Must own the parent to pack children");
        require(units[_parentId].status == Status.Active, "Parent unit cannot be in transit or sold");
        require(_count > 0, "Count must be greater than zero");
        require(_count <= 250, "Batch count exceeds limit");
        require(uint8(_childLevel) > uint8(units[_parentId].level), "Child level must be strictly lower in hierarchy");

        address originalMfr = units[_parentId].manufacturer;
        uint256 rootId = units[_parentId].rootId == 0 ? _parentId : units[_parentId].rootId;
        uint256 expiry = units[_parentId].expiry;

        for (uint256 i = 0; i < _count; i++) {
            uint256 childId = _createUnit(
                _parentId,
                rootId,
                _childLevel,
                originalMfr,
                _msgSender(),
                _metadata,
                1,
                _serialHash,
                expiry
            );
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
        uint256 _quantity,
        bytes32 _serialHash,
        uint256 _expiry
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
            metadata: _metadata,
            serialHash: _serialHash,
            expiry: _expiry
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
        require(hasRole(MANUFACTURER_ROLE, _msgSender()) || hasRole(HANDLER_ROLE, _msgSender()), "Sender role has been revoked");
        uint256 rId = units[_id].rootId == 0 ? _id : units[_id].rootId;
        require(!recalledRoots[rId], "Batch is recalled");
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
                _quantity,
                units[_id].serialHash,
                units[_id].expiry
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
        require(hasRole(MANUFACTURER_ROLE, _msgSender()) || hasRole(HANDLER_ROLE, _msgSender()), "Receiver role revoked");

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

    function clearRejected(uint256 _id, bytes32 _evidenceHash) external onlyQA {
        require(units[_id].status == Status.Rejected, "Unit is not rejected");

        units[_id].status = Status.Active;

        emit RejectedCleared(_id, _msgSender(), _evidenceHash);
    }

    function _sellQuantity(
        uint256 _id,
        uint256 _quantity,
        string memory _childSerial
    ) internal returns (uint256) {
        require(_quantity > 0 && _quantity <= units[_id].quantity, "Invalid sale quantity");

        uint256 soldUnitId = _id;
        if (_quantity < units[_id].quantity) {
            uint256 remainingQuantity = units[_id].quantity - _quantity;
            string memory baseMeta = units[_id].metadata;
            units[_id].quantity = remainingQuantity;
            units[_id].metadata = _formatMetadata(baseMeta, remainingQuantity);

            string memory soldMetadata = _formatMetadata(baseMeta, _quantity);
            bytes32 childSerialHash = bytes(_childSerial).length > 0
                ? keccak256(bytes(_childSerial))
                : units[_id].serialHash;

            soldUnitId = _createUnit(
                _id,
                units[_id].rootId == 0 ? _id : units[_id].rootId,
                units[_id].level,
                units[_id].manufacturer,
                _msgSender(),
                soldMetadata,
                _quantity,
                childSerialHash,
                units[_id].expiry
            );
            children[_id].push(soldUnitId);
        }

        units[soldUnitId].status = Status.Sold;
        units[soldUnitId].pendingReceiver = address(0);

        emit UnitSold(soldUnitId, _msgSender());
        return soldUnitId;
    }

    function sellQuantityWithSerial(
        uint256 _id,
        uint256 _quantity,
        string calldata _childSerial
    ) external onlyCurrentOwner(_id) onlyDispenser dispensable(_id) returns (uint256) {
        return _sellQuantity(_id, _quantity, _childSerial);
    }

    function sellQuantity(uint256 _id, uint256 _quantity) external onlyCurrentOwner(_id) onlyDispenser dispensable(_id) returns (uint256) {
        return _sellQuantity(_id, _quantity, "");
    }

    function markAsSold(uint256 _id) external onlyCurrentOwner(_id) onlyDispenser dispensable(_id) {
        _sellQuantity(_id, units[_id].quantity, "");
    }

    function verifySerial(uint256 _id, string calldata _serial) external view returns (bool) {
        require(_id > 0 && _id <= unitCounter, "Unit does not exist");
        if (units[_id].serialHash == bytes32(0)) {
            return true;
        }
        return units[_id].serialHash == keccak256(bytes(_serial));
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
