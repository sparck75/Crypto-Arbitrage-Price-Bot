require('dotenv').config()
const HDWalletProvider = require('@truffle/hdwallet-provider')
const Web3 = require('web3')
const UniswapV3PriceCalculator = require('./util/UniswapPriceCalculator')
const SushiSwapPriceCalculator = require('./util/SushiSwapPriceCalculator')
const AaveFlashLoan = require('./artifacts/contracts/AaveFlashLoanV3.sol/AaveFlashLoanV3.json')
const { WETH, WBTC, APE, ERC20ABI, UniPool1Address, UniPool2Address, UniPool3Address, SushiPair1Address, SushiPair2Address, SushiPair3Address, AaveFlashLoanAddress, AavePoolDataProviderv3Address, AavePoolDataProviderv3ABI } = require('./EVMAddresses/evmAddresses')
const { default: BigNumber } = require('bignumber.js')
const {getPercentDifference, getTokenDirection, wrapToken, sendToken, getWalletEthBalance, getPolygonGasPrice} = require('./util/ArbitrageUtil')
const fs = require('fs')

/**
 * Initializes web3 with account information
 */
const web3 = new Web3(new HDWalletProvider(process.env.PRIVATE_KEY,process.env.RPC_URL))

/**
 * Initializes UniSwap calculator objects
 */
let uniswapPriceCalc = new UniswapV3PriceCalculator(web3, UniPool1Address)
let uniswapPriceCalc2 = new UniswapV3PriceCalculator(web3, UniPool2Address)
let uniswapPriceCalc3 = new UniswapV3PriceCalculator(web3, UniPool3Address)

/**
 * Initializes Sushi Calculator objects
 */
let sushiSwapPriceCalc = new SushiSwapPriceCalculator(web3, SushiPair1Address)
let sushiSwapPriceCalc2 = new SushiSwapPriceCalculator(web3, SushiPair2Address)
let sushiSwapPriceCalc3 = new SushiSwapPriceCalculator(web3, SushiPair3Address)

/**
 * Initializes global variables
 */
let uniPrice
let uniPrice2
let uniPrice3

let sushiPrice
let sushiPrice2
let sushiPrice3

let pair1Dif
let pair2Dif
let pair3Dif

let pair1AavePool = ''
let pair2AavePool = ''
let pair3AavePool = ''
let aaveSetDirection = false

let loopCounter = 0

/**
 * Intializes contracts needed for Flash Loan
 */
const AaveFlashLoanContract = new web3.eth.Contract(AaveFlashLoan.abi, AaveFlashLoanAddress)
const AaveDataProvder = new web3.eth.Contract(AavePoolDataProviderv3ABI, AavePoolDataProviderv3Address)

/**
 * Displays current token information in a table format
 */
let displayTokenInfo = () =>{
    console.table({           
        'UniSwap V3':{
            [uniswapPriceCalc.symbolsToString()]: uniPrice.toFixed(8),
            [uniswapPriceCalc2.symbolsToString()]: uniPrice2.toFixed(8),
            [uniswapPriceCalc3.symbolsToString()]: uniPrice3.toFixed(8)
        },
        'SushiSwap V2':{
            [sushiSwapPriceCalc.symbolsToString()]: sushiPrice.toFixed(8),
            [sushiSwapPriceCalc2.symbolsToString()]: sushiPrice2.toFixed(8),
            [sushiSwapPriceCalc3.symbolsToString()]: sushiPrice3.toFixed(8)
        },
        'Pair % Dif':{
            [uniswapPriceCalc.symbolsToString()]:  `${pair1Dif.toFixed(4)} %`,
            [uniswapPriceCalc2.symbolsToString()]: `${pair2Dif.toFixed(4)} %`,
            [uniswapPriceCalc3.symbolsToString()]: `${pair3Dif.toFixed(4)} %`
        }
    })
}

/**
 * Flash loan execution method. Needs to be moved to the ArbitrageBot.js file
 * @param {*} token0 
 * @param {*} token1 
 * @param {*} direction 
 * @param {*} poolFee 
 * @param {*} amountToTrade 
 * @param {*} amountOut 
 * @param {*} deadline 
 */
let  executeFlashLoan = async (token0, token1, direction, poolFee, amountToTrade, amountOut, deadline) => {
    displayTokenInfo()
    try{
        await AaveFlashLoanContract.methods.myFlashLoanCall(token0,token1,direction,poolFee,amountToTrade.toString(),amountOut.toString(),deadline).send({
            from: process.env.ACCOUNT,
            gasPrice: await getPolygonGasPrice('fast')
        })
        await tokenWithdraw(token0)
    }catch(error){
        console.log('Flash Loan execution error')
        console.log(error)
    }
}

/**
 * Token withdraw method. Needs to be moved to the ArbitrageUtil.js
 * file.
 * @param {*} token0 
 */
let tokenWithdraw = async(token0) => {
    try{
        await AaveFlashLoanContract.methods.withdrawERC20Token(token0).send({
            from: process.env.ACCOUNT,
            gasPrice: await getPolygonGasPrice('standard')
        })
    }catch(error){
        console.log('Token withdraw error')
        console.log(error)
    }
}

/**
 * Main function that is used for polling every 3 seconds.
 * @returns 
 */
let main = async () => {
    // Stops polling if one is already happening
    if (isPolling){
        return
    }

    isPolling = true
    try{
        
        uniPrice = await uniswapPriceCalc.getPairPrice()
        uniPrice2 = await uniswapPriceCalc2.getPairPrice()
        uniPrice3 = await uniswapPriceCalc3.getPairPrice()

        sushiPrice = await sushiSwapPriceCalc.getPairPrice()
        sushiPrice2 = await sushiSwapPriceCalc2.getPairPrice()
        sushiPrice3 = await sushiSwapPriceCalc3.getPairPrice()

        pair1Dif = getPercentDifference(uniPrice, sushiPrice)
        pair2Dif = getPercentDifference(uniPrice2,sushiPrice2)
        pair3Dif = getPercentDifference(uniPrice3,sushiPrice3)

    }catch(error){
        console.log(error)
    }

    // Need to determine if the assets are available to borrow from Aave
    // We will exit the process if neither are found. If one is found,
    // we will alter the decimals of the trade and swap token0Trade
    // to be token1Trade. This way we can start with a token that Aave
    // has reserves for. 
    if(!aaveSetDirection){
        try{
            await AaveDataProvder.methods.getATokenTotalSupply(uniswapPriceCalc.token0Trade).call()
            pair1AavePool = true

        }catch(error){
            try{
                await AaveDataProvder.methods.getATokenTotalSupply(uniswapPriceCalc.token1Trade).call()
                pair1AavePool = false
            }catch(error){
                console.log(`Neither of the tokens are available to borrow. Token0 ${uniswapPriceCalc.token0Trade} - Token1 ${uniswapPriceCalc.token1Trade}`)
                process.exit()
            }
        }
        try{
            await AaveDataProvder.methods.getATokenTotalSupply(uniswapPriceCalc2.token0Trade).call()
            pair2AavePool = true

        }catch(error){
            try{
                await AaveDataProvder.methods.getATokenTotalSupply(uniswapPriceCalc2.token1Trade).call()
                pair2AavePool = false
            }catch(error){
                console.log(`Neither of the tokens are available to borrow. Token0 ${uniswapPriceCalc.token0Trade} - Token1 ${uniswapPriceCalc.token1Trade}`)
                process.exit()
            }
        }
        try{
            await AaveDataProvder.methods.getATokenTotalSupply(uniswapPriceCalc3.token0Trade).call()
            pair3AavePool = true

        }catch(error){
            try{
                await AaveDataProvder.methods.getATokenTotalSupply(uniswapPriceCalc3.token1Trade).call()
                pair3AavePool = false
            }catch(error){
                console.log(`Neither of the tokens are available to borrow. Token0 ${uniswapPriceCalc.token0Trade} - Token1 ${uniswapPriceCalc.token1Trade}`)
                process.exit()
            }
        }
        // We have to alter the current information to be on the
        // correct side now that we know which side the token needs
        // to be for a successful loan from Aave.
        if(!pair1AavePool){
            tempToken = uniswapPriceCalc.token0Trade
            uniswapPriceCalc.token0Trade = uniswapPriceCalc.token1Trade
            uniswapPriceCalc.token1Trade = tempToken

            tempDecimal = uniswapPriceCalc.token0TradeDecimals
            uniswapPriceCalc.token0TradeDecimals = uniswapPriceCalc.token1TradeDecimals
            uniswapPriceCalc.token1TradeDecimals = tempDecimal
        }
        if(!pair2AavePool){
            tempToken = uniswapPriceCalc2.token0Trade
            uniswapPriceCalc2.token0Trade = uniswapPriceCalc2.token1Trade
            uniswapPriceCalc2.token1Trade = tempToken

            tempDecimal = uniswapPriceCalc2.token0TradeDecimals
            uniswapPriceCalc2.token0TradeDecimals = uniswapPriceCalc2.token1TradeDecimals
            uniswapPriceCalc2.token1TradeDecimals = tempDecimal
        
        }
        if(!pair3AavePool){
            tempToken = uniswapPriceCalc3.token0Trade
            uniswapPriceCalc3.token0Trade = uniswapPriceCalc3.token1Trade
            uniswapPriceCalc3.token1Trade = tempToken

            tempDecimal = uniswapPriceCalc3.token0TradeDecimals
            uniswapPriceCalc3.token0TradeDecimals = uniswapPriceCalc3.token1TradeDecimals
            uniswapPriceCalc3.token1TradeDecimals = tempDecimal
        
        }
        aaveSetDirection = true
    }

    // Displays table information roughly every 30 seconds
    if(loopCounter%10==0){
        displayTokenInfo()
    }

    // Ensures that the difference in pairs is high enough for profit.
    // If a profit can be made, we execute the flash loan with the information
    // needed.
    if(pair1Dif >= 2){
        console.log('pair1')
        let direction = getTokenDirection(uniPrice,sushiPrice, !pair1AavePool)
        console.log(direction)
        let amountToTrade = BigNumber(1).shiftedBy(parseInt(uniswapPriceCalc.token0TradeDecimals)).dividedBy(4).toString()
        console.log(amountToTrade)
        await executeFlashLoan(uniswapPriceCalc.token0Trade,uniswapPriceCalc.token1Trade,direction,uniswapPriceCalc.poolFee,amountToTrade,0,50000000000)
    }
    if(pair2Dif >= 2){
        console.log('pair2')
        let direction = getTokenDirection(uniPrice,sushiPrice, !pair2AavePool)
        console.log(direction)
        let amountToTrade = BigNumber(1).shiftedBy(parseInt(uniswapPriceCalc2.token0TradeDecimals)).dividedBy(4).toString()
        console.log(amountToTrade)
        await executeFlashLoan(uniswapPriceCalc2.token0Trade,uniswapPriceCalc2.token1Trade,direction,uniswapPriceCalc2.poolFee,amountToTrade,0,50000000000)
    }
    if(pair3Dif >= 1){
        console.log('pair3')
        let direction = getTokenDirection(uniPrice3,sushiPrice3, !pair3AavePool)
        console.log(direction)
        console.log(!pair3AavePool)
        console.log(uniswapPriceCalc3.token0Trade)
        let amountToTrade = BigNumber(1).shiftedBy(parseInt(uniswapPriceCalc3.token0TradeDecimals)).dividedBy(6).toFixed(0)
        console.log(amountToTrade)
        await executeFlashLoan(uniswapPriceCalc3.token0Trade,uniswapPriceCalc3.token1Trade,direction,uniswapPriceCalc3.poolFee,amountToTrade,0,50000000000)
    }

    // Write log file for liveness check in Kubernetes cluster
    fs.writeFileSync('./tmp/healthcheck.log','running')
    // Sets information for next polling
    isPolling = false
    loopCounter += 1
}

// Starts the polling of the main() function
let priceMonitor
let isPolling = false
const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 3000 // 3 Seconds
priceMonitor = setInterval(async () => { await main() }, POLLING_INTERVAL)