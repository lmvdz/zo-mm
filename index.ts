// Setup provider (see anchor docs for more instructions on setting up a provider using your wallet)
import * as anchor from "@project-serum/anchor";
import * as zo from "@zero_one/client";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TpuClient } from "tpu-client";
import { config } from "dotenv";
import { Program } from "@project-serum/anchor";
import { FundingInfo, OrderType } from "@zero_one/client";


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

export declare class Wallet implements IWallet {
    readonly payer: Keypair;
    constructor(payer: Keypair);
    signTransaction(tx: Transaction): Promise<Transaction>;
    signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
    get publicKey(): PublicKey;
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
    program: Program<zo.Zo>
    state: zo.State
    margin: zo.Margin
    running: boolean
    spread: number
    markets: Map<string, zo.ZoMarket>
    orderbooks: Map<string, Orderbook>

    constructor(tpuClient: TpuClient, provider: anchor.Provider, idl: zo.Zo, program: Program<zo.Zo>, state: zo.State, margin: zo.Margin) {
        this.tpuClient = tpuClient;
        this.provider = provider;
        this.idl = idl;
        this.program = program;
        this.state = state;
        this.margin = margin;
        this.running = false;
    }

    static async load() {
        const tpuClient = await TpuClient.load(new Connection(process.env.RPC_URL));
        const provider = new anchor.Provider( tpuClient.connection, botWallet, { commitment: 'processed' } );
        const idl = await anchor.Program.fetchIdl(new PublicKey(zo.ZERO_ONE_MAINNET_PROGRAM_ID), provider) as zo.Zo;
        const program = new anchor.Program(idl, zo.ZERO_ONE_MAINNET_PROGRAM_ID, provider) as Program<zo.Zo>; 
        const state = await zo.State.load(program, zo.ZO_MAINNET_STATE_KEY) as zo.State;
        const margin = await zo.Margin.create(program, state) as zo.Margin;

        return new MarketMaker(tpuClient, provider, idl, program, state, margin);
    }



    public stop() {
        this.running = false;
    }

    public start() {
        this.running = true;
    }
    
    public setSpread(spread: number) {
        this.spread = spread;
    }

    public rebalance() {

    }

    public log() {

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

    public async loadMarketMakerOrderForMarket(symbol: string) : Promise<Array<Order>>{
        
        this.loadMarket(symbol);
        const market = this.markets.get(symbol);
        if (!market) return [];
        const orders = await market.loadOrdersForOwner(this.tpuClient.connection, this.margin.control.pubkey) as Array<Order>
        if (!orders) return [];
        return orders;
        
    }

    public async fetchOrderBook(symbol: string) : Promise<Orderbook> {
        this.loadMarket(symbol);
        const market = this.markets.get(symbol);
        if (!market) throw new Error("Invalid Market Symbol");
        const [asks, bids] = [ await market.loadAsks(this.tpuClient.connection), await market.loadBids(this.tpuClient.connection) ];
        const orderbook = { asks, bids } as Orderbook;
        this.orderbooks.set(symbol, orderbook);
        return orderbook;
    }

    public async fetchFunding(symbol: string) : Promise<FundingInfo> {
        return this.state.getFundingInfo(symbol)
    }

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
        const market = Object.keys(this.state.markets).map(key => this.state.markets[key]).find(market => market.pubKey.toBase58() === position.marketKey)
        if (!market) throw new Error("invalid market key")
        return await this[position.isLong ? 'short' : 'long'](market.symbol, { limit: {} } as OrderType, market.markPrice.number, position.coins.number)
    }

    public async cancel(symbol: string, order: Order) : Promise<string> {
        return await this.margin.cancelPerpOrder({ symbol, isLong: order.side === 'buy', orderId: order.orderId })
    }

    public async settleFunds(symbol: string) : Promise<string> {
        return await this.margin.settleFunds(symbol);
    }

    public async getMarketSymbols() : Promise<Array<string>> {
        return Object.keys(this.state.markets).map(key => this.state.markets[key].symbol)
    }

}



