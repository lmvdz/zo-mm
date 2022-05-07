import { streamNormalized, normalizeBookChanges, combine, compute, computeBookSnapshots, StreamNormalizedOptions, Exchange, BookPriceLevel, Optional } from 'tardis-dev'
import { config } from 'dotenv'

config({path: './.env.local'});

const args = process.argv.splice(2);

const pair = args[0];

export const marketMap = {
    BTC: {
        'bybit': ['BTCUSDT', 'BTCUSD'],
        'ftx': ['BTC-PERP'],
        'binance-futures': ['btcusdt']
    },
    ETH: {
        'bybit': ['ETHUSDT', 'ETHUSD'],
        'ftx': ['ETH-PERP'],
        'binance-futures': ['ethusdt']
    },
    SOL: {
        'bybit': ['SOLUSDT'],
        'ftx': ['SOL-PERP'],
        'binance-futures': ['solusdt']
    },
    LUNA: {
        'bybit': ['LUNAUSDT'],
        'ftx': ['LUNA-PERP'],
        'binance-futures': ['lunausdt']
    },
    AVAX: {
        'bybit': ['AVAXUSDT'],
        'ftx': ['AVAX-PERP'],
        'binance-futures': ['avaxusdt']
    },
    APE: {
        'bybit': ['APEUSDT'],
        'ftx': ['APE-PERP'],
        'binance-futures': ['apeusdt']
    },
    NEAR: {
        'bybit': ['NEARUSDT'],
        'ftx': ['NEAR-PERP'],
        'binance-futures': ['nearusdt']
    },
    GMT: {
        'bybit': ['GMTUSDT'],
        'ftx': ['GMT-PERP'],
        'binance-futures': ['gmtusdt']
    }
}

export interface Pairs {
    [key: string]: Spreads
}

export interface Spreads {
    [key: string]: Spread
}

export interface Spread {
    spread: number,
    bestBid: Optional<BookPriceLevel>,
    bestAsk: Optional<BookPriceLevel>
}

const spreads = {} as Spreads


const exchangesToStream = Object.keys(marketMap[pair]).map(exchange => {
    return { exchange, symbols: marketMap[pair][exchange] } as StreamNormalizedOptions<any>
});

// console.log(exchangesToStream)


const realTimeStreams = exchangesToStream.map((exchange) => {
    return streamNormalized(exchange, normalizeBookChanges)
})

const messages = combine(...realTimeStreams)

const realTimeQuoteComputable = computeBookSnapshots({
    depth: 1,
    interval: 0,
    name: 'realtime_quote'
})

const messagesWithQuotes = compute(messages, realTimeQuoteComputable);


(async () => {
    // update spreads info real-time
    for await (const message of messagesWithQuotes) {
        if(!process.send) process.exit()
        if (message.type === 'book_snapshot') {
            spreads[message.exchange] = {
                spread: message.asks[0].price - message.bids[0].price,
                bestBid: message.bids[0],
                bestAsk: message.asks[0]
            } as Spread
            process.send(JSON.stringify({ type: 'spreads', spreads, pair }));
        }
    }
})();







