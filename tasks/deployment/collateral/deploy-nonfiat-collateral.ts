import { getChainId } from '../../../common/blockchain-utils'
import { task } from 'hardhat/config'
import { ContractFactory } from 'ethers'
import { Collateral } from '../../../typechain'

task('deploy-nonfiat-collateral', 'Deploys a non-fiat Collateral')
  .addParam('referenceUnitFeed', 'Reference Price Feed address')
  .addParam('targetUnitFeed', 'Target Unit Price Feed address')
  .addParam('tokenAddress', 'ERC20 token address')
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

    const NonFiatCollateralFactory: ContractFactory = await hre.ethers.getContractFactory(
      'NonFiatCollateral',
      {
        libraries: { OracleLib: params.oracleLib },
      }
    )

    const collateral = <Collateral>await NonFiatCollateralFactory.connect(deployer).deploy(
      params.referenceUnitFeed,
      params.targetUnitFeed,
      params.tokenAddress,
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
        `Deployed Non-Fiat Collateral to ${hre.network.name} (${chainId}): ${collateral.address}`
      )
    }

    return { collateral: collateral.address }
  })
