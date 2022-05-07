import { streamNormalized, normalizeBookChanges, combine, compute, computeBookSnapshots, StreamNormalizedOptions, Exchange, BookPriceLevel, Optional } from 'tardis-dev'



const exchangesToStream = [
    { exchange: 'bitmex', symbols: ['XBTUSD'] } as StreamNormalizedOptions<'bitmex'>,
    { exchange: 'deribit' as Exchange, symbols: ['BTC-PERPETUAL'] } as StreamNormalizedOptions<'deribit'>,
    { exchange: 'cryptofacilities' as Exchange, symbols: ['PI_XBTUSD'] } as StreamNormalizedOptions<'cryptofacilities'>,
    { exchange: 'ftx' as Exchange, symbols: ['BTC-PERP']} as StreamNormalizedOptions<'ftx'>,
    { exchange: 'binance-futures' as Exchange, symbols: ['btcusdt']} as StreamNormalizedOptions<'binance-futures'>
]

const realTimeStreams = exchangesToStream.map((e) => {
    return streamNormalized(e, normalizeBookChanges)
})

const messages = combine(...realTimeStreams)

const realTimeQuoteComputable = computeBookSnapshots({
    depth: 1,
    interval: 0,
    name: 'realtime_quote'
})

const messagesWithQuotes = compute(messages, realTimeQuoteComputable)

const spreads = {} as Spreads

export interface Spreads {
    [key: string]: Spread
}
export interface Spread {
    spread: number,
    bestBid: Optional<BookPriceLevel>,
    bestAsk: Optional<BookPriceLevel>
}

(async() => {
    // update spreads info real-time
    for await (const message of messagesWithQuotes) {
        if(!process.send) process.exit()
        if (message.type === 'book_snapshot') {
            spreads[message.exchange] = {
                spread: message.asks[0].price - message.bids[0].price,
                bestBid: message.bids[0],
                bestAsk: message.asks[0]
            } as Spread
            process.send(JSON.stringify({ type: 'spreads', spreads }));
        }
    }

})();
