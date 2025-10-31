import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { TradeSignal } from '../../services/tradeManager/core/types.js';

interface SignalCounts {
    buy: number;
    sell: number;
    neutral: number;
}

interface AnalyzerStats {
    slopeSignAnalyzer: SignalCounts;
    momentumCompositeAnalyzer: SignalCounts;
    movingAverageAnalyzer: SignalCounts;
    tradeSignalFusion: SignalCounts;
}

interface TickData {
    tick: {
        slopeSignAnalyzer: {
            result: {
                tradeSignal: TradeSignal;
            };
        };
        momentumCompositeAnalyzer: {
            result: {
                tradeSignal: TradeSignal;
            };
        };
        movingAverageAnalyzer: {
            result: {
                tradeSignal: TradeSignal;
            };
        };
        tradeSignalFusion: {
            result: {
                tradeSignal: TradeSignal;
            };
        };
    };
}

function initializeStats(): AnalyzerStats {
    return {
        slopeSignAnalyzer: { buy: 0, sell: 0, neutral: 0 },
        momentumCompositeAnalyzer: { buy: 0, sell: 0, neutral: 0 },
        movingAverageAnalyzer: { buy: 0, sell: 0, neutral: 0 },
        tradeSignalFusion: { buy: 0, sell: 0, neutral: 0 }
    };
}

function updateSignalCount(counts: SignalCounts, signal: TradeSignal): void {
    if (!signal) return;

    switch (signal) {
        case TradeSignal.Buy:
            counts.buy++;
            break;
        case TradeSignal.Sell:
            counts.sell++;
            break;
        case TradeSignal.Neutral:
            counts.neutral++;
            break;
    }
}

async function parseLogFile(logFilePath: string): Promise<AnalyzerStats> {
    const stats = initializeStats();

    const fileStream = fs.createReadStream(logFilePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY
    });

    for await (const line of rl) {
        if (!line.trim()) continue;

        try {
            const data: TickData = JSON.parse(line);

            if (!data.tick) continue;

            // SlopeSignAnalyzer
            updateSignalCount(
                stats.slopeSignAnalyzer,
                data.tick.slopeSignAnalyzer.result.tradeSignal
            );

            // MomentumCompositeAnalyzer
            updateSignalCount(
                stats.momentumCompositeAnalyzer,
                data.tick.momentumCompositeAnalyzer.result.tradeSignal
            );

            // MovingAverageAnalyzer
            updateSignalCount(
                stats.movingAverageAnalyzer,
                data.tick.movingAverageAnalyzer.result.tradeSignal
            );

            // TradeSignalFusion
            updateSignalCount(
                stats.tradeSignalFusion,
                data.tick.tradeSignalFusion.result.tradeSignal
            );
        } catch {
            // Skip invalid JSON lines (like the "started" line)
            continue;
        }
    }

    return stats;
}

function printStats(stats: AnalyzerStats): void {
    console.log('\n=== Trade Signal Analysis ===\n');

    console.log('SlopeSignAnalyzer:');
    console.log(`  Buys:     ${stats.slopeSignAnalyzer.buy}`);
    console.log(`  Sells:    ${stats.slopeSignAnalyzer.sell}`);
    console.log(`  Neutrals: ${stats.slopeSignAnalyzer.neutral}`);
    console.log(`  Total:    ${stats.slopeSignAnalyzer.buy + stats.slopeSignAnalyzer.sell + stats.slopeSignAnalyzer.neutral}\n`);

    console.log('MomentumCompositeAnalyzer:');
    console.log(`  Buys:     ${stats.momentumCompositeAnalyzer.buy}`);
    console.log(`  Sells:    ${stats.momentumCompositeAnalyzer.sell}`);
    console.log(`  Neutrals: ${stats.momentumCompositeAnalyzer.neutral}`);
    console.log(`  Total:    ${stats.momentumCompositeAnalyzer.buy + stats.momentumCompositeAnalyzer.sell + stats.momentumCompositeAnalyzer.neutral}\n`);

    console.log('MovingAverageAnalyzer:');
    console.log(`  Buys:     ${stats.movingAverageAnalyzer.buy}`);
    console.log(`  Sells:    ${stats.movingAverageAnalyzer.sell}`);
    console.log(`  Neutrals: ${stats.movingAverageAnalyzer.neutral}`);
    console.log(`  Total:    ${stats.movingAverageAnalyzer.buy + stats.movingAverageAnalyzer.sell + stats.movingAverageAnalyzer.neutral}\n`);

    console.log('TradeSignalFusion:');
    console.log(`  Buys:     ${stats.tradeSignalFusion.buy}`);
    console.log(`  Sells:    ${stats.tradeSignalFusion.sell}`);
    console.log(`  Neutrals: ${stats.tradeSignalFusion.neutral}`);
    console.log(`  Total:    ${stats.tradeSignalFusion.buy + stats.tradeSignalFusion.sell + stats.tradeSignalFusion.neutral}\n`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: node dist/tools/logParser/parser.js <log-file-path>');
        console.error('Example: node dist/tools/logParser/parser.js records/trade-controller-1_1761756068332/log.log');
        process.exit(1);
    }

    const firstArg = args[0];
    if (!firstArg) {
        console.error('Error: No log file path provided');
        process.exit(1);
    }

    const logFilePath = path.resolve(process.cwd(), firstArg);

    if (!fs.existsSync(logFilePath)) {
        console.error(`Error: Log file not found: ${logFilePath}`);
        process.exit(1);
    }

    console.log(`Parsing log file: ${logFilePath}`);

    const stats = await parseLogFile(logFilePath);
    printStats(stats);
}

await main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
