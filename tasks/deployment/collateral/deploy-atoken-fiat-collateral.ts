import { getChainId } from '../../../common/blockchain-utils'
import { task } from 'hardhat/config'
import { ContractFactory } from 'ethers'
import { ATokenFiatCollateral } from '../../../typechain'

task('deploy-atoken-fiat-collateral', 'Deploys an AToken Fiat Collateral')
  .addParam('priceFeed', 'Price Feed address')
  .addParam('staticAToken', 'Static AToken address')
  .addParam('rewardToken', 'Reward token address')
  .addParam('tradingValMin', 'Trade Range - Min in UoA')
  .addParam('tradingValMax', 'Trade Range - Max in UoA')
  .addParam('tradingAmtMin', 'Trade Range - Min in whole toks')
  .addParam('tradingAmtMax', 'Trade Range - Max in whole toks')
  .addParam('oracleTimeout', 'Max oracle timeout')
  .addParam('targetName', 'Target Name')
  .addParam('defaultThreshold', 'Default Threshold')
  .addParam('delayUntilDefault', 'Delay until default')
  .addParam('oracleLib', 'Oracle library address')
  .setAction(async (params, hre) => {
    const [deployer] = await hre.ethers.getSigners()

    const chainId = await getChainId(hre)

    const ATokenCollateralFactory: ContractFactory = await hre.ethers.getContractFactory(
      'ATokenFiatCollateral',
      {
        libraries: { OracleLib: params.oracleLib },
      }
    )

    const collateral = <ATokenFiatCollateral>await ATokenCollateralFactory.connect(deployer).deploy(
      params.priceFeed,
      params.staticAToken,
      params.rewardToken,
      {
        minVal: params.tradingValMin,
        maxVal: params.tradingValMax,
        minAmt: params.tradingAmtMin,
        maxAmt: params.tradingAmtMax,
      },
      params.oracleTimeout,
      params.targetName,
      params.defaultThreshold,
      params.delayUntilDefault
    )
    await collateral.deployed()

    if (!params.noOutput) {
      console.log(
        `Deployed AToken Fiat Collateral to ${hre.network.name} (${chainId}): ${collateral.address}`
      )
    }

    return { collateral: collateral.address }
  })
