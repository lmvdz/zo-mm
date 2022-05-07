// Setup provider (see anchor docs for more instructions on setting up a provider using your wallet)
import { default as zo } from "@zero_one/client";
import { ConfirmOptions, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TpuClient } from "tpu-client";
import { config } from "dotenv";
import { createProgram, createProvider, FundingInfo, IDL, OrderType, Zo } from "@zero_one/client";
import { fork, ChildProcess } from 'child_process'
import { Spreads, Spread, Pairs, marketMap } from "./tardis";
import * as anchor from "@project-serum/anchor";
import Decimal from "decimal.js";

config({path: './.env.local'});

export const to_b58 = function(B,A){var d=[],s="",i,j,c,n;for(i in B){j=0,c=B[i];s+=c||s.length^i?"":1;while(j in d||c){n=d[j];n=n?n*256+c:c;c=n/58|0;d[j]=n%58;j++}}while(j--)s+=A[d[j]];return s};
export const from_b58 = function(S,A){var d=[],b=[],i,j,c,n;for(i in S){j=0,c=A.indexOf(S[i]);if(c<0)return undefined;c||b.length^i?i:b.push(0);while(j in d||c){n=d[j];n=n?n*58+c:c;c=n>>8;d[j]=n%256;j++}}while(j--)b.push(d[j]);return new Uint8Array(b)};

const botKeyEnvVariable = "BOT_KEY"
// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
const botKey = process.env[botKeyEnvVariable]

if (botKey === undefined) {
    console.error('need a ' + botKeyEnvVariable +' env variable');
    process.exit()
}


export interface IWallet {
    signTransaction(tx: Transaction): Promise<Transaction>;
    signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
    publicKey: PublicKey;
}

class Wallet {
    readonly payer: Keypair;

    constructor(payer) {
        this.payer = payer;
    }
    async signTransaction(tx: Transaction) {
        tx.partialSign(this.payer);
        return tx;
    }
    async signAllTransactions(txs: Array<Transaction>) {
        return txs.map((t) => { 
            t.partialSign(this.payer);
            return t;
        });
    }
    get publicKey() {
        return this.payer.publicKey;
    }
}

// setup wallet
let keypair;

try {
    keypair = Keypair.fromSecretKey(
        from_b58(botKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")!
    );
} catch {
    try {
        keypair = Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(botKey))
        );
    } catch {
        console.error('Failed to parse private key from Uint8Array (solana-keygen) and base58 encoded string (phantom wallet export)')
        process.exit();
    }
}
const botWallet = new Wallet(keypair);


const ACTIVE_MARKETS_DELIMITER = process.env.ACTIVE_MARKETS_DELIMITER || ','
const ACTIVE_MARKETS = process.env.ACTIVE_MARKETS.split(ACTIVE_MARKETS_DELIMITER) || ["BTC"];
const MAX_LOSS = process.env.MAX_LOSS || 0.25;
const MAX_GAIN = process.env.MAX_GAIN || 0.25;
const CANCEL_ORDER_INTERVAL_SECONDS = Number.parseFloat(process.env.CANCEL_ORDER_INTERVAL_SECONDS) || 1;
const MARKET_REBALANCE_TIMEOUT_SECONDS = Number.parseFloat(process.env.MARKET_REBALANCE_TIMEOUT_SECONDS) || 2;
const SPREAD_PERCENTAGE = Number.parseFloat(process.env.MM_SPREAD_PERCENTAGE) || 0.1

interface Order {
    orderId: anchor.BN;
    controlAddress: PublicKey;
    openOrdersSlot: number;
    price: number;
    priceLots: anchor.BN;
    size: number;
    feeTier: number;
    sizeLots: anchor.BN;
    side: "buy" | "sell";
    clientId?: anchor.BN;
}

interface Orderbook {
    bids: zo.Orderbook
    asks: zo.Orderbook
}

class MarketMaker {

    tpuClient: TpuClient
    provider: anchor.Provider
    idl: zo.Zo
    program: anchor.Program<zo.Zo>
    state: zo.State
    margin: zo.Margin
    running: boolean

    spreads: Pairs
    mmSpreads: Map<string, number>
    midPrices: Map<string, number>
    markets: Map<string, zo.ZoMarket>
    orderbooks: Map<string, Orderbook>
    tardis: Map<string, ChildProcess>
    

    constructor(tpuClient: TpuClient, provider: anchor.Provider, idl: zo.Zo, program: anchor.Program<zo.Zo>, state: zo.State, margin: zo.Margin) {
        this.tpuClient = tpuClient;
        this.provider = provider;
        this.idl = idl;
        this.program = program;
        this.state = state;
        this.margin = margin;

        this.spreads = {}
        this.midPrices = new Map<string, number>();
        this.tardis = new Map<string, ChildProcess>();
        this.mmSpreads = new Map<string, number>();
        this.orderbooks = new Map<string, Orderbook>();
        this.markets = new Map<string, zo.ZoMarket>();
        

    }

    static async load() {

        const tpuClient = await TpuClient.load(new Connection(process.env.RPC_URL));
        const provider = createProvider( tpuClient.connection, botWallet, { commitment: 'processed' } );
        const program = createProgram(provider, zo.Cluster.Mainnet);
        const state = await zo.State.load(program, zo.ZO_MAINNET_STATE_KEY) as zo.State;
        const margin = await zo.Margin.load(program, state) as zo.Margin;

        return new MarketMaker(tpuClient, provider, zo.IDL, program, state, margin);
    }


    public async startTardis() {
        [...this.markets.keys()].map(market => market.split('-')[0]).forEach(market => {
            if(!this.tardis.has(market)) {
                const tardis = fork('./tardis.ts', [market], { stdio: ['pipe', 'pipe', 'pipe', 'ipc']})
                this.tardis.set(market, tardis);
                if(tardis.stderr)
                tardis.stderr.on('data', (data : Buffer) => {
                    console.log(data.toString());
                })

                tardis.on('close', (code, sig) => {
                    console.log('tardis died');
                    tardis.kill();
                    this.tardis.delete(market);
                    this.startTardis();
                })

                if(tardis.stdout)
                tardis.stdout.on('data', (data: Buffer) => {
                    console.log(data.toString());
                })

                tardis.on('message', (data : string) => {
                    let d = JSON.parse(data);
                    switch(d.type) {
                    case 'started':
                        break;
                    case 'data':
                        break;
                    case 'spreads':
                        this.spreads[d.pair] = d.spreads as Spreads;
                        this.midPrices.set(d.pair, Object.keys(d.spreads).map(key => d.spreads[key]).reduce((midPrice, exchange) => midPrice !== 0 ? ((midPrice  + (exchange.bestBid.price + (0.5 * exchange.spread))) * 0.5) : exchange.bestBid.price + (0.5 * exchange.spread), 0));
                        break;
                    case 'error':
                        console.error(d.data);
                        break;
                    }
                })
            }
        })
    }
    
    public setSpread(market: string, spread: number) {
        this.mmSpreads.set(market, spread);
    }

    public rebalance() {
        // reload positions
        this.margin.loadPositions();
        this.state.loadMarkets();
        this.margin.loadBalances();
        this.margin.loadOrders();
        // loop over markets
        [...this.markets.keys()].forEach((market, index) => {
            console.log('rebalancing market '+ market);
            setTimeout(async () => {
                // get the market maker's orders
                const orders = await this.loadMarketMakerOrdersForMarket(market)
                // cancel each order
                await Promise.allSettled(orders.map((order, index) => {
                    return new Promise((resolve, reject) => {
                        try {
                            setTimeout(() => {
                                console.log('cancelling order ' + order.orderId);
                                this.cancel(market, order).then((tx) => {
                                    console.log("cancelled order " + order.orderId);
                                    resolve(tx)
                                }).catch(error => {
                                    reject(error);
                                })
                            }, 1000 * index * CANCEL_ORDER_INTERVAL_SECONDS)
                        } catch(error) {
                            reject(error);
                        }
                    })
                }))
                // close open position if +/- uPNL gte absolute value of MAX_GAIN_LOSS_PERCENT
                const positionInfo = this.margin.position(market)
                if (positionInfo && !positionInfo.coins.dec.eq(new Decimal(0)) && !positionInfo.pCoins.dec.eq(new Decimal(0))) {
                    const entry = positionInfo.coins.decimal.div(positionInfo.pCoins.dec);
                    const pnl = this.margin.positionPnL(positionInfo);
                    const GAIN = entry.add(entry.mul(new Decimal(MAX_GAIN)))
                    const LOSS = entry.sub(entry.mul(new Decimal(MAX_LOSS)))
                    if (pnl.gte(GAIN) || pnl.lte(LOSS.mul(new Decimal(-1)))) {
                        try {
                            await this.close(positionInfo);
                        } catch(error) {
                            console.error(error);
                        }
                    } else {
                        console.log('current position ' + positionInfo.marketKey + ' pnl ' + pnl.toFixed(4));
                    }
                }
                // open orders using tardis based mark price as mid price

                const base = market.split('-PERP')[0];
                if (this.midPrices.has(base)) {
                    const midPrice = this.midPrices.get(base);
                    const spread = (midPrice*SPREAD_PERCENTAGE);
                    const marketBySymbol = (await this.state.getMarketBySymbol(market));
                    const marketInfo = this.state.markets[market];
                    const maxQuote = this.margin.balances['USDC'].div(ACTIVE_MARKETS.length).div(2).number;
                    const size = ((marketBySymbol.quoteSizeNumberToLots(maxQuote).toNumber() / marketBySymbol.priceNumberToLots(marketInfo.markPrice.number).toNumber())) / ( 10 ** (marketInfo.assetDecimals - marketInfo.assetLotSize))
                    try {
                        this.long(market, { limit: {} },  (midPrice - (spread/2)), size).then((tx) => {
                            console.log('opened long ' + tx)
                        }).catch(error => {
                            console.error(error);
                        })
                        this.short(market, { limit: {} },  (midPrice + (spread/2)), size).then((tx) => {
                            console.log('opened short ' + tx)
                        }).catch(error => {
                            console.error(error);
                        })
                    } catch(error) {
                        console.error(error);
                    }
                    
                } else {
                    console.log('no price found for base ' + base);
                }
            }, 1000 * index * MARKET_REBALANCE_TIMEOUT_SECONDS)
            
            
            
        })
        // recalculate long/short positions based on latest midPrice from tardis
    }

    public async loadMarket(symbol: string) : Promise<zo.ZoMarket> {
        if (this.markets.has(symbol)) return this.markets.get(symbol);

        const marketKey = this.state.getMarketKeyBySymbol(symbol);
        if (!marketKey) throw new Error("Invalid Market Symbol");

        const market = await zo.ZoMarket.load(this.tpuClient.connection, marketKey, {}, zo.ZO_DEX_MAINNET_PROGRAM_ID)
        if (!market) throw new Error("Invalid Market Symbol");

        this.markets.set(symbol, market)
        return market;
    }

    public async loadMarketMakerOrdersForMarket(symbol: string) : Promise<Array<Order>>{
        
        this.loadMarket(symbol);
        const market = this.markets.get(symbol);
        if (!market) return [];
        const orders = await market.loadOrdersForOwner(this.tpuClient.connection, this.margin.control.pubkey) as Array<Order>
        if (!orders) return [];
        return orders;
        
    }

    // public async fetchOrderBook(symbol: string) : Promise<Orderbook> {
    //     this.loadMarket(symbol);
    //     const market = this.markets.get(symbol);
    //     if (!market) throw new Error("Invalid Market Symbol");
    //     const [asks, bids] = [ await market.loadAsks(this.tpuClient.connection), await market.loadBids(this.tpuClient.connection) ];
    //     const orderbook = { asks, bids } as Orderbook;
    //     this.orderbooks.set(symbol, orderbook);
    //     return orderbook;
    // }

    public async deposit(size: number, mint: PublicKey = zo.USDC_MAINNET_MINT_ADDRESS) : Promise<string> {
        return await this.margin.deposit(mint, size, false);
    }

    public async withdraw(size: number, mint: PublicKey = zo.USDC_MAINNET_MINT_ADDRESS) : Promise<string> {
        return await this.margin.withdraw(mint, size, false);
    }

    public async long(symbol: string, orderType: zo.OrderType = { limit: {} } as zo.OrderType, price: number, size: number) : Promise<string> {
        return await this.margin.placePerpOrder({symbol, orderType, isLong: true, price, size});
    }

    public async short(symbol: string, orderType: zo.OrderType = { limit: {} } as zo.OrderType, price: number, size: number) : Promise<string> {
        return await this.margin.placePerpOrder({symbol, orderType, isLong: false, price, size});
    }

    public async close(position: zo.PositionInfo) {
        const market = this.state.markets[position.marketKey]
        if (!market) throw new Error("invalid market key");
        console.log('attempting to close position');
        return await this[position.isLong ? 'short' : 'long'](market.symbol, { limit: {} } as OrderType, market.markPrice.number, position.coins.number);
    }

    public async cancel(symbol: string, order: Order) : Promise<string> {
        return await this.margin.cancelPerpOrder({ symbol, isLong: order.side === 'buy', orderId: order.orderId })
    }

    public async settleFunds(symbol: string) : Promise<string> {
        return await this.margin.settleFunds(symbol);
    }

}

const rebalanceIntervalInSeconds = Number.parseFloat(process.env.REBALANCE_INTERVAL) || 30


MarketMaker.load().then(marketMaker => {

    // load markets
    Promise.allSettled(ACTIVE_MARKETS.map(async marketToMake => {
        return marketMaker.loadMarket(marketToMake + '-PERP')
    })).then(() => {

        // start the process for streaming market prices from CEXs for all loaded markets
        marketMaker.startTardis();

        // rebalance the market maker every X seconds
        setInterval(() => {
            marketMaker.rebalance();
        }, 1000 * (rebalanceIntervalInSeconds > 0 ? rebalanceIntervalInSeconds : 1))

        process.stdout.write('Market Maker has started!\n');
    })
});


