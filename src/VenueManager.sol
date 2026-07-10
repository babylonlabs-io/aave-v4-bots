// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {IMorpho} from "./interfaces/Morpho/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "./interfaces/Morpho/IMorphoFlashLoanCallback.sol";
import {IAaveV3Pool} from "./interfaces/AaveV3/IAaveV3Pool.sol";
import {IAaveV3FlashLoanSimpleReceiver} from "./interfaces/AaveV3/IAaveV3FlashLoanSimpleReceiver.sol";
import {TransientSlotLib} from "./lib/TransientSlotLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Bytes32Lib} from "./lib/Bytes32Lib.sol";
import {ISwapVenue} from "./interfaces/SwapVenue/ISwapVenue.sol";
import {ISwapVenueCallback} from "./interfaces/SwapVenue/ISwapVenueCallback.sol";
import {TokenAmountLib} from "vault-contracts/applications/aave/lib/types/TokenAmountLib.sol";
import {VenueForwardDataLib} from "./lib/VenueForwardDataLib.sol";
import {ExpectCallback} from "./base/ExpectCallback.sol";
import {Types} from "./lib/Types.sol";

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
///         - Data once passed into VenueManager will ALWAYS be encoded with a header to differentiate layers of encoding.
///         - VenueManager does not know about the data structure. It will always stamp the data with a header and pass it
///         to the next layer. The next layer will decode the data and pass it to the next layer, and so on.
///         - Once the same data is passed back to VenueManager, it will decode the data and pass it to the previous layer
///         with _resumeAfterCallback(). The previous layer will deduce its own state using the data

abstract contract VenueManager is
    IMorphoFlashLoanCallback,
    IAaveV3FlashLoanSimpleReceiver,
    ISwapVenueCallback,
    ExpectCallback
{
    using TransientSlotLib for bytes32;
    using SafeERC20 for IERC20;

    string private constant CONTRACT_NAME = "VenueManager";
    bytes32 private constant VENUE_DEBTS_LENGTH_TK = keccak256(abi.encodePacked(CONTRACT_NAME, ".venueDebts.length"));

    function _setUpSwapVenue(address venueAddress, bytes memory forwardData) internal {
        _expectCallback(venueAddress);
        ISwapVenue(venueAddress).setUp(VenueForwardDataLib.encodeStandard(forwardData));
        _requireCompleteCallback();
    }

    function _flashLoan(Types.FlashData memory flashData, uint256 amountOut, bytes memory forwardData) internal {
        if (flashData.venueType == Types.VenueType.Morpho) {
            _expectCallback(flashData.venueAddress);
            IMorpho(flashData.venueAddress)
                .flashLoan(flashData.token, amountOut, VenueForwardDataLib.encodeMorpho(forwardData, flashData.token));
        } else if (flashData.venueType == Types.VenueType.AaveV3) {
            _expectCallback(flashData.venueAddress);
            IAaveV3Pool(flashData.venueAddress)
                .flashLoanSimple(
                    address(this), flashData.token, amountOut, VenueForwardDataLib.encodeStandard(forwardData), 0
                );
        } else if (flashData.venueType == Types.VenueType.UniswapV4FlashSwap) {
            _expectCallback(flashData.venueAddress);
            ISwapVenue(flashData.venueAddress)
                .flashSwap(
                    flashData.token, amountOut, flashData.swapData, VenueForwardDataLib.encodeStandard(forwardData)
                );
        } else {
            revert("VenueManager: Unsupported venue type");
        }
        _requireCompleteCallback();
    }

    // ---------------------- CALLBACKS ----------------------

    function onSetUpCallback(address, bytes calldata venueData) external consumeCallback(msg.sender) {
        _resumeAfterCallback(VenueForwardDataLib.decodeStandard(venueData));
    }

    /// @notice Callback called when a flash loan occurs.
    /// @dev The callback is called only if data is not empty.
    /// @param assets The amount of assets that was flash loaned.
    /// @param venueData Arbitrary data passed to the `flashLoan` function.
    function onMorphoFlashLoan(uint256 assets, bytes calldata venueData) external consumeCallback(msg.sender) {
        (bytes memory forwardData, address token) = VenueForwardDataLib.decodeMorpho(venueData);
        _addVenueDebt(msg.sender, token, assets);
        _resumeAfterCallback(forwardData);
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
        _addVenueDebt(msg.sender, asset, amount + premium);
        _resumeAfterCallback(VenueForwardDataLib.decodeStandard(venueData));
        IERC20(asset).safeIncreaseAllowance(msg.sender, amount + premium);
        return true;
    }

    /// @notice Callback called when a flash loan occurs.
    /// @dev The callback is called only if data is not empty.
    /// @param paymentToken The address of the token for repaying the flash swap.
    /// @param amount The amount of tokens for repaying the flash swap.
    /// @param venueData Arbitrary data passed to the `flashLoan` function.
    function onSwapVenueFlashSwap(address paymentToken, uint256 amount, bytes calldata venueData)
        external
        consumeCallback(msg.sender)
    {
        _addVenueDebt(msg.sender, paymentToken, amount);
        _resumeAfterCallback(VenueForwardDataLib.decodeStandard(venueData));
        IERC20(paymentToken).safeIncreaseAllowance(msg.sender, amount);
    }

    // ---------------------- TRANSIENT DEBT (GENERAL) ----------------------

    function _getAllDebts() internal view returns (Types.VenueDebt[] memory debts) {
        uint256 length = VENUE_DEBTS_LENGTH_TK.loadUint256();
        debts = new Types.VenueDebt[](length);
        for (uint256 i = 0; i < length; i++) {
            (bytes32 tokenTK, bytes32 venueTK, bytes32 amountTK) = _getVenueDebtTK(i);
            debts[i] = Types.VenueDebt({
                token: tokenTK.loadAddress(), venue: venueTK.loadAddress(), amount: amountTK.loadUint256()
            });
        }
    }

    function _addVenueDebt(address venue, address token, uint256 amount) internal {
        uint256 length = VENUE_DEBTS_LENGTH_TK.loadUint256();
        (bytes32 tokenTK, bytes32 venueTK, bytes32 amountTK) = _getVenueDebtTK(length);
        tokenTK.storeAddress(token);
        venueTK.storeAddress(venue);
        amountTK.storeUint256(amount);
        VENUE_DEBTS_LENGTH_TK.storeUint256(length + 1);
    }

    function _clearVenueDebts() internal {
        for (uint256 i = 0; i < VENUE_DEBTS_LENGTH_TK.loadUint256(); i++) {
            (bytes32 tokenTK, bytes32 venueTK, bytes32 amountTK) = _getVenueDebtTK(i);
            tokenTK.storeAddress(address(0));
            venueTK.storeAddress(address(0));
            amountTK.storeUint256(0);
        }
        VENUE_DEBTS_LENGTH_TK.storeUint256(0);
    }

    // ---------------------- TRANSIENT DEBT (AMOUNT) ----------------------

    function _getVenueDebtTK(uint256 i) internal pure returns (bytes32 tokenTK, bytes32 venueTK, bytes32 amountTK) {
        tokenTK = keccak256(abi.encodePacked(CONTRACT_NAME, ".venueDebts[", i, "].token"));
        venueTK = keccak256(abi.encodePacked(CONTRACT_NAME, ".venueDebts[", i, "].venue"));
        amountTK = keccak256(abi.encodePacked(CONTRACT_NAME, ".venueDebts[", i, "].amount"));
    }

    // ---------------------- ABSTRACT FUNCTIONS ----------------------

    function _resumeAfterCallback(bytes memory forwardData) internal virtual;

    // ---------------------- INTERNAL FUNCTIONS ----------------------

    function _venueRequiresSetup(Types.VenueType venueType, address venueAddress) internal view returns (bool) {
        return (venueType == Types.VenueType.UniswapV4FlashSwap || venueType == Types.VenueType.UniswapV4FlashLoan)
            && ISwapVenue(venueAddress).requireSetup();
    }
}
