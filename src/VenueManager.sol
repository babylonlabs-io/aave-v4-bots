// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {IMorpho} from "./interfaces/Morpho/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "./interfaces/Morpho/IMorphoFlashLoanCallback.sol";
import {IAaveV3Pool} from "./interfaces/AaveV3/IAaveV3Pool.sol";
import {IAaveV3FlashLoanSimpleReceiver} from "./interfaces/AaveV3/IAaveV3FlashLoanSimpleReceiver.sol";
import {TransientSlotLib} from "./lib/TransientSlotLib.sol";
import {TransientArrayLib, ArrayKey} from "./lib/TransientArrayLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Bytes32Lib} from "./lib/Bytes32Lib.sol";
import {ISwapVenue} from "./interfaces/SwapVenue/ISwapVenue.sol";
import {ISwapVenueCallback} from "./interfaces/SwapVenue/ISwapVenueCallback.sol";
import {TokenAmountLib} from "vault-contracts/applications/aave/lib/types/TokenAmountLib.sol";
import {VenueDataLib} from "./lib/VenueDataLib.sol";
import {ExpectCallback} from "./base/ExpectCallback.sol";

/// @dev    VenueManager treats flash loan and flash swap the same
///         The expected behavior of a venue is:
///         - The venue will transfer the flash-borrowed asset to the contract
///         - The contract will record the flash loan debt on the callback
///         - The venue will use ERC20.transferFrom() to pull the flash-borrowed asset back from the contract
///
///         For flash swap venue such as UniswapV4, a wrapper is required. The wrapper will first flash swap
///         the asset from UniswapV4, then transfer the asset to VenueManager before calling the callback.
///         The VenueManager will approve the flash-borrowed asset back to the wrapper, and the wrapper will
///         transfer the asset back to UniswapV4 to complete the flash swap.
///
///         Data once passed into VenueManager will ALWAYS be encoded with a header to differentiate layers of encoding.

abstract contract VenueManager is
    IMorphoFlashLoanCallback,
    IAaveV3FlashLoanSimpleReceiver,
    ISwapVenueCallback,
    ExpectCallback
{
    using TransientSlotLib for bytes32;
    using TransientArrayLib for ArrayKey;
    using SafeERC20 for IERC20;

    enum VenueType {
        AaveV3,
        Morpho,
        UniswapV4
    }

    string private constant CONTRACT_NAME = "VenueManager";
    bytes32 private constant EXPECTED_CALLBACK = keccak256(abi.encodePacked(CONTRACT_NAME, ".expectedCallback"));
    bytes32 private constant FLASH_LOAN_TOKEN_ADDRESSES_TK =
        keccak256(abi.encodePacked(CONTRACT_NAME, ".flashLoanTokenAddresses"));

    function _setUpSwapVenue(address venueAddress, bytes memory data) internal {
        _expectCallback(venueAddress);
        ISwapVenue(venueAddress).setUp(VenueDataLib.encodeStandard(data));
    }

    function _flashLoan(VenueType venueType, address venueAddress, address token, uint256 amount, bytes calldata data)
        internal
    {
        if (venueType == VenueType.Morpho) {
            _expectCallback(venueAddress);
            IMorpho(venueAddress).flashLoan(token, amount, VenueDataLib.encodeMorpho(data, token));
        } else if (venueType == VenueType.AaveV3) {
            _expectCallback(venueAddress);
            IAaveV3Pool(venueAddress)
                .flashLoanSimple(address(this), token, amount, VenueDataLib.encodeStandard(data), 0);
        } else if (venueType == VenueType.UniswapV4) {
            _expectCallback(venueAddress);
            ISwapVenue(venueAddress).flashLoan(token, amount, VenueDataLib.encodeStandard(data));
        } else {
            revert("VenueManager: Unsupported venue type");
        }
    }

    // ---------------------- CALLBACKS ----------------------

    function onSetUpCallback(address, bytes calldata venueData) external consumeCallback(msg.sender) {
        _resumeAfterCallback(VenueDataLib.decodeStandard(venueData));
    }

    /// @notice Callback called when a flash loan occurs.
    /// @dev The callback is called only if data is not empty.
    /// @param assets The amount of assets that was flash loaned.
    /// @param venueData Arbitrary data passed to the `flashLoan` function.
    function onMorphoFlashLoan(uint256 assets, bytes calldata venueData) external consumeCallback(msg.sender) {
        (bytes memory data, address token) = VenueDataLib.decodeMorpho(venueData);
        _increaseFlashLoanDebt(token, assets);
        _resumeAfterCallback(data);
        IERC20(token).safeIncreaseAllowance(msg.sender, assets);
    }

    /**
     * @notice Executes an operation after receiving the flash-borrowed asset
     * @dev Ensure that the contract can return the debt + premium, e.g., has
     *      enough funds to repay and has approved the Pool to pull the total amount
     * @param asset The address of the flash-borrowed asset
     * @param amount The amount of the flash-borrowed asset
     * @param premium The fee of the flash-borrowed asset
     * @param initiator The address of the flashloan initiator
     * @param venueData The byte-encoded params passed when initiating the flashloan
     * @return True if the execution of the operation succeeds, false otherwise
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata venueData
    ) external consumeCallback(msg.sender) returns (bool) {
        initiator;
        _increaseFlashLoanDebt(asset, amount + premium);
        _resumeAfterCallback(VenueDataLib.decodeStandard(venueData));
        IERC20(asset).safeIncreaseAllowance(msg.sender, amount + premium);
        return true;
    }

    /// @notice Callback called when a flash loan occurs.
    /// @dev The callback is called only if data is not empty.
    /// @param paymentToken The address of the token for repaying the flash swap.
    /// @param amount The amount of tokens for repaying the flash swap.
    /// @param venueData Arbitrary data passed to the `flashLoan` function.
    function onSwapVenueFlashLoan(address paymentToken, uint256 amount, bytes calldata venueData)
        external
        consumeCallback(msg.sender)
    {
        _increaseFlashLoanDebt(paymentToken, amount);
        _resumeAfterCallback(VenueDataLib.decodeStandard(venueData));
        IERC20(paymentToken).safeIncreaseAllowance(msg.sender, amount);
    }

    // ---------------------- TRANSIENT DEBT (GENERAL) ----------------------

    function _getAllDebts() internal view returns (TokenAmountLib.TokenAmount[] memory debts) {
        ArrayKey tokenAddressesTK = ArrayKey.wrap(FLASH_LOAN_TOKEN_ADDRESSES_TK);
        uint256 length = tokenAddressesTK.len();
        debts = new TokenAmountLib.TokenAmount[](length);
        for (uint256 i = 0; i < length; i++) {
            address token = Bytes32Lib.toAddress(tokenAddressesTK.at(i));
            uint256 amount = _getFlashLoanDebt(token);
            debts[i] = TokenAmountLib.TokenAmount({token: token, amount: amount});
        }
    }

    function _increaseFlashLoanDebt(address token, uint256 amount) internal {
        ArrayKey tokenAddressesTK = ArrayKey.wrap(FLASH_LOAN_TOKEN_ADDRESSES_TK);
        bytes32 tokenB32 = Bytes32Lib.toBytes32(token);
        if (!tokenAddressesTK.contains(tokenB32)) {
            tokenAddressesTK.append(tokenB32);
        }

        bytes32 debtTK = _getFlashLoanDebtTK(token);
        debtTK.storeUint256(debtTK.loadUint256() + amount);
    }

    function _clearFlashLoanDebts() internal {
        ArrayKey tokenAddressesTK = ArrayKey.wrap(FLASH_LOAN_TOKEN_ADDRESSES_TK);
        uint256 length = tokenAddressesTK.len();
        for (uint256 i = 0; i < length; i++) {
            address token = Bytes32Lib.toAddress(tokenAddressesTK.at(i));
            _clearFlashLoanDebt(token);
        }
        tokenAddressesTK.clear();
    }

    // ---------------------- TRANSIENT DEBT (AMOUNT) ----------------------

    function _getFlashLoanDebt(address token) internal view returns (uint256) {
        return _getFlashLoanDebtTK(token).loadUint256();
    }

    function _clearFlashLoanDebt(address token) internal {
        _getFlashLoanDebtTK(token).storeUint256(0);
    }

    function _getFlashLoanDebtTK(address token) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(CONTRACT_NAME, ".flashLoanDebt", token));
    }

    // ---------------------- ABSTRACT FUNCTIONS ----------------------

    function _resumeAfterCallback(bytes memory data) internal virtual;
}
