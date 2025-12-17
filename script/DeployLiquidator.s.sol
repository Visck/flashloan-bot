// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/FlashLoanLiquidator.sol";

contract DeployLiquidator is Script {
    function run() external {
        // Usa a private key passada via --private-key flag
        vm.startBroadcast();

        FlashLoanLiquidator liquidator = new FlashLoanLiquidator();

        console.log("FlashLoanLiquidator deployed at:", address(liquidator));
        console.log("Owner:", liquidator.owner());

        vm.stopBroadcast();
    }
}
