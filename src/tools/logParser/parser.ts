import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { TradeSignal } from '../../services/tradeManager/core/types.js';

type SentimentDirection = 'up' | 'down' | 'neutral';

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

interface SignalDuration {
  signal: TradeSignal;
  startTick: number;
  endTick: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  durationTicks: number;
}

interface AgreementEvent {
  tick: number;
  fusionSignal: TradeSignal;
  slopeAgrees: boolean;
  momentumAgrees: boolean;
  maAgrees: boolean;
  unanimousAgreement: boolean;
}

interface SentimentEvent {
  tick: number;
  timestamp: number;
  rawSentiment: number;
  filteredSentiment: number;
  direction: SentimentDirection;
}

interface Tier1Stats {
  // Signal duration tracking
  signalDurations: SignalDuration[];
  
  // False positive tracking
  falsePositives: SignalDuration[];
  
  // Agreement tracking
  agreementEvents: AgreementEvent[];
  
  // Sentiment lag tracking
  sentimentEvents: SentimentEvent[];
  fusionSignalChanges: Array<{
    tick: number;
    timestamp: number;
    signal: TradeSignal;
    fromSignal: TradeSignal;
  }>;
  
  // Confidence tracking
  confidenceScores: Array<{
    tick: number;
    signal: TradeSignal;
    confidence: number;
  }>;
}

interface TickData {
  tick: {
    timestamp: number;
    heatmapAnalyzer: {
      result: {
        sentimentScore: number;
      };
    };
    deltaFilterAnalyzer: {
      filteredScore: number;
    };
    slopeSignAnalyzer: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
    momentumCompositeAnalyzer: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
    movingAverageAnalyzer: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
    tradeSignalFusion: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
  };
}

function initializeStats(): AnalyzerStats {
  return {
    slopeSignAnalyzer: { buy: 0, sell: 0, neutral: 0 },
    momentumCompositeAnalyzer: { buy: 0, sell: 0, neutral: 0 },
    movingAverageAnalyzer: { buy: 0, sell: 0, neutral: 0 },
    tradeSignalFusion: { buy: 0, sell: 0, neutral: 0 },
  };
}

function initializeTier1Stats(): Tier1Stats {
  return {
    signalDurations: [],
    falsePositives: [],
    agreementEvents: [],
    sentimentEvents: [],
    fusionSignalChanges: [],
    confidenceScores: [],
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

function getSentimentDirection(sentiment: number): SentimentDirection {
  if (sentiment >= 30) return 'up';
  if (sentiment <= -30) return 'down';
  return 'neutral';
}

function processTickData(
  tick: TickData['tick'],
  tickNumber: number,
  stats: AnalyzerStats,
  tier1Stats: Tier1Stats
): void {
  const fusionSignal = tick.tradeSignalFusion.result.tradeSignal;
  const fusionConfidence = tick.tradeSignalFusion.result.confidence;
  const slopeSignal = tick.slopeSignAnalyzer.result.tradeSignal;
  const momentumSignal = tick.momentumCompositeAnalyzer.result.tradeSignal;
  const maSignal = tick.movingAverageAnalyzer.result.tradeSignal;
  const rawSentiment = tick.heatmapAnalyzer.result.sentimentScore;
  const filteredSentiment = tick.deltaFilterAnalyzer.filteredScore;
  const timestamp = tick.timestamp;

  // Update basic stats
  updateSignalCount(stats.slopeSignAnalyzer, slopeSignal);
  updateSignalCount(stats.momentumCompositeAnalyzer, momentumSignal);
  updateSignalCount(stats.movingAverageAnalyzer, maSignal);
  updateSignalCount(stats.tradeSignalFusion, fusionSignal);

  // Track sentiment events
  const currentSentimentDirection = getSentimentDirection(filteredSentiment);
  tier1Stats.sentimentEvents.push({
    tick: tickNumber,
    timestamp,
    rawSentiment,
    filteredSentiment,
    direction: currentSentimentDirection,
  });

  // Track confidence scores for non-neutral fusion signals
  if (fusionSignal !== TradeSignal.Neutral) {
    tier1Stats.confidenceScores.push({
      tick: tickNumber,
      signal: fusionSignal,
      confidence: fusionConfidence,
    });
  }

  // Track agreement when fusion has a signal
  if (fusionSignal !== TradeSignal.Neutral) {
    trackAgreement(tickNumber, fusionSignal, slopeSignal, momentumSignal, maSignal, tier1Stats);
  }
}

function trackAgreement(
  tickNumber: number,
  fusionSignal: TradeSignal,
  slopeSignal: TradeSignal,
  momentumSignal: TradeSignal,
  maSignal: TradeSignal,
  tier1Stats: Tier1Stats
): void {
  const slopeAgrees = slopeSignal === fusionSignal;
  const momentumAgrees = momentumSignal === fusionSignal;
  const maAgrees = maSignal === fusionSignal;
  const unanimousAgreement = slopeAgrees && momentumAgrees && maAgrees;

  tier1Stats.agreementEvents.push({
    tick: tickNumber,
    fusionSignal,
    slopeAgrees,
    momentumAgrees,
    maAgrees,
    unanimousAgreement,
  });
}

function recordSignalDuration(
  previousFusionSignal: TradeSignal,
  currentSignalStartTick: number,
  currentSignalStartTime: number,
  tickNumber: number,
  timestamp: number,
  fusionSignal: TradeSignal,
  tier1Stats: Tier1Stats
): void {
  const duration: SignalDuration = {
    signal: previousFusionSignal,
    startTick: currentSignalStartTick,
    endTick: tickNumber - 1,
    startTime: currentSignalStartTime,
    endTime: timestamp,
    durationMs: timestamp - currentSignalStartTime,
    durationTicks: tickNumber - currentSignalStartTick,
  };

  tier1Stats.signalDurations.push(duration);

  // Check if it's a false positive (reversed within 20 ticks)
  if (duration.durationTicks < 20 && fusionSignal !== TradeSignal.Neutral) {
    const isReversal =
      (previousFusionSignal === TradeSignal.Buy && fusionSignal === TradeSignal.Sell) ||
      (previousFusionSignal === TradeSignal.Sell && fusionSignal === TradeSignal.Buy);

    if (isReversal) {
      tier1Stats.falsePositives.push(duration);
    }
  }
}

function handleSignalChange(
  fusionSignal: TradeSignal,
  previousFusionSignal: TradeSignal,
  tickNumber: number,
  timestamp: number,
  currentSignalStartTick: number,
  currentSignalStartTime: number,
  tier1Stats: Tier1Stats
): { newStartTick: number; newStartTime: number } {
  // Record signal change
  tier1Stats.fusionSignalChanges.push({
    tick: tickNumber,
    timestamp,
    signal: fusionSignal,
    fromSignal: previousFusionSignal,
  });

  // If previous signal was not neutral, record its duration
  if (previousFusionSignal !== TradeSignal.Neutral) {
    recordSignalDuration(
      previousFusionSignal,
      currentSignalStartTick,
      currentSignalStartTime,
      tickNumber,
      timestamp,
      fusionSignal,
      tier1Stats
    );
  }

  // Start tracking new signal
  if (fusionSignal !== TradeSignal.Neutral) {
    return { newStartTick: tickNumber, newStartTime: timestamp };
  }

  return { newStartTick: currentSignalStartTick, newStartTime: currentSignalStartTime };
}

async function parseLogFile(logFilePath: string): Promise<{ basic: AnalyzerStats; tier1: Tier1Stats }> {
  const stats = initializeStats();
  const tier1Stats = initializeTier1Stats();

  // Tracking state across ticks
  let tickNumber = 0;
  let previousFusionSignal: TradeSignal = TradeSignal.Neutral;
  let currentSignalStartTick = 0;
  let currentSignalStartTime = 0;

  const fileStream = fs.createReadStream(logFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const data: TickData = JSON.parse(line);
      if (!data.tick) continue;

      const tick = data.tick;
      const fusionSignal = tick.tradeSignalFusion.result.tradeSignal;
      const timestamp = tick.timestamp;

      // Process all tick data
      processTickData(tick, tickNumber, stats, tier1Stats);

      // Track fusion signal changes and durations
      if (fusionSignal !== previousFusionSignal) {
        const result = handleSignalChange(
          fusionSignal,
          previousFusionSignal,
          tickNumber,
          timestamp,
          currentSignalStartTick,
          currentSignalStartTime,
          tier1Stats
        );
        currentSignalStartTick = result.newStartTick;
        currentSignalStartTime = result.newStartTime;
        previousFusionSignal = fusionSignal;
      }

      tickNumber++;
    } catch {
      // Skip invalid JSON lines (like the "started" line)
      continue;
    }
  }

  // Handle final signal if session ended on non-neutral
  if (previousFusionSignal !== TradeSignal.Neutral && tier1Stats.sentimentEvents.length > 0) {
    const lastEvent = tier1Stats.sentimentEvents.at(-1);
    if (lastEvent) {
      tier1Stats.signalDurations.push({
        signal: previousFusionSignal,
        startTick: currentSignalStartTick,
        endTick: tickNumber - 1,
        startTime: currentSignalStartTime,
        endTime: lastEvent.timestamp,
        durationMs: lastEvent.timestamp - currentSignalStartTime,
        durationTicks: tickNumber - currentSignalStartTick,
      });
    }
  }

  return { basic: stats, tier1: tier1Stats };
}

function printBasicStats(stats: AnalyzerStats): void {
  console.log('\n=== BASIC SIGNAL COUNTS ===\n');

  console.log('SlopeSignAnalyzer:');
  console.log(`  Buys:     ${stats.slopeSignAnalyzer.buy}`);
  console.log(`  Sells:    ${stats.slopeSignAnalyzer.sell}`);
  console.log(`  Neutrals: ${stats.slopeSignAnalyzer.neutral}`);
  console.log(
    `  Total:    ${stats.slopeSignAnalyzer.buy + stats.slopeSignAnalyzer.sell + stats.slopeSignAnalyzer.neutral}\n`
  );

  console.log('MomentumCompositeAnalyzer:');
  console.log(`  Buys:     ${stats.momentumCompositeAnalyzer.buy}`);
  console.log(`  Sells:    ${stats.momentumCompositeAnalyzer.sell}`);
  console.log(`  Neutrals: ${stats.momentumCompositeAnalyzer.neutral}`);
  console.log(
    `  Total:    ${stats.momentumCompositeAnalyzer.buy + stats.momentumCompositeAnalyzer.sell + stats.momentumCompositeAnalyzer.neutral}\n`
  );

  console.log('MovingAverageAnalyzer:');
  console.log(`  Buys:     ${stats.movingAverageAnalyzer.buy}`);
  console.log(`  Sells:    ${stats.movingAverageAnalyzer.sell}`);
  console.log(`  Neutrals: ${stats.movingAverageAnalyzer.neutral}`);
  console.log(
    `  Total:    ${stats.movingAverageAnalyzer.buy + stats.movingAverageAnalyzer.sell + stats.movingAverageAnalyzer.neutral}\n`
  );

  console.log('TradeSignalFusion:');
  console.log(`  Buys:     ${stats.tradeSignalFusion.buy}`);
  console.log(`  Sells:    ${stats.tradeSignalFusion.sell}`);
  console.log(`  Neutrals: ${stats.tradeSignalFusion.neutral}`);
  const totalTicks =
    stats.tradeSignalFusion.buy + stats.tradeSignalFusion.sell + stats.tradeSignalFusion.neutral;
  console.log(`  Total:    ${totalTicks}`);

  if (totalTicks > 0) {
    const buyPercent = ((stats.tradeSignalFusion.buy / totalTicks) * 100).toFixed(1);
    const sellPercent = ((stats.tradeSignalFusion.sell / totalTicks) * 100).toFixed(1);
    const neutralPercent = ((stats.tradeSignalFusion.neutral / totalTicks) * 100).toFixed(1);
    console.log(`  Buy %:    ${buyPercent}%`);
    console.log(`  Sell %:   ${sellPercent}%`);
    console.log(`  Neutral %: ${neutralPercent}%\n`);
  }
}

function printSignalDurations(tier1: Tier1Stats): void {
  const buyDurations = tier1.signalDurations.filter(d => d.signal === TradeSignal.Buy);
  const sellDurations = tier1.signalDurations.filter(d => d.signal === TradeSignal.Sell);

  console.log('--- Signal Duration Distribution ---');
  console.log(`Total Signals: ${tier1.signalDurations.length}`);
  console.log(`  Buy Signals:  ${buyDurations.length}`);
  console.log(`  Sell Signals: ${sellDurations.length}\n`);

  if (buyDurations.length > 0) {
    const avgBuyDurationMs = buyDurations.reduce((sum, d) => sum + d.durationMs, 0) / buyDurations.length;
    const avgBuyDurationTicks = buyDurations.reduce((sum, d) => sum + d.durationTicks, 0) / buyDurations.length;
    console.log(`Buy Signal Average Duration: ${(avgBuyDurationMs / 1000 / 60).toFixed(2)} minutes (${avgBuyDurationTicks.toFixed(1)} ticks)`);
  }

  if (sellDurations.length > 0) {
    const avgSellDurationMs = sellDurations.reduce((sum, d) => sum + d.durationMs, 0) / sellDurations.length;
    const avgSellDurationTicks = sellDurations.reduce((sum, d) => sum + d.durationTicks, 0) / sellDurations.length;
    console.log(`Sell Signal Average Duration: ${(avgSellDurationMs / 1000 / 60).toFixed(2)} minutes (${avgSellDurationTicks.toFixed(1)} ticks)`);
  }

  // Duration histogram
  if (tier1.signalDurations.length > 0) {
    const under1m = tier1.signalDurations.filter(d => d.durationMs < 60000).length;
    const between1and3m = tier1.signalDurations.filter(d => d.durationMs >= 60000 && d.durationMs < 180000).length;
    const between3and5m = tier1.signalDurations.filter(d => d.durationMs >= 180000 && d.durationMs < 300000).length;
    const over5m = tier1.signalDurations.filter(d => d.durationMs >= 300000).length;

    console.log('\nDuration Histogram:');
    console.log(`  <1 minute:   ${under1m} signals (${((under1m / tier1.signalDurations.length) * 100).toFixed(1)}%)`);
    console.log(`  1-3 minutes: ${between1and3m} signals (${((between1and3m / tier1.signalDurations.length) * 100).toFixed(1)}%)`);
    console.log(`  3-5 minutes: ${between3and5m} signals (${((between3and5m / tier1.signalDurations.length) * 100).toFixed(1)}%)`);
    console.log(`  >5 minutes:  ${over5m} signals (${((over5m / tier1.signalDurations.length) * 100).toFixed(1)}%)\n`);
  }
}

function printFalsePositives(tier1: Tier1Stats): void {
  console.log('--- False Positive Detection ---');
  console.log(`False Positives (reversed <20 ticks): ${tier1.falsePositives.length}`);
  if (tier1.signalDurations.length > 0) {
    const fpRate = ((tier1.falsePositives.length / tier1.signalDurations.length) * 100).toFixed(1);
    console.log(`False Positive Rate: ${fpRate}%\n`);
  }
}

function printAgreementRates(tier1: Tier1Stats): void {
  console.log('--- Analyzer Agreement Rates ---');
  if (tier1.agreementEvents.length > 0) {
    const slopeAgreementCount = tier1.agreementEvents.filter(e => e.slopeAgrees).length;
    const momentumAgreementCount = tier1.agreementEvents.filter(e => e.momentumAgrees).length;
    const maAgreementCount = tier1.agreementEvents.filter(e => e.maAgrees).length;
    const unanimousCount = tier1.agreementEvents.filter(e => e.unanimousAgreement).length;

    const slopeRate = ((slopeAgreementCount / tier1.agreementEvents.length) * 100).toFixed(1);
    const momentumRate = ((momentumAgreementCount / tier1.agreementEvents.length) * 100).toFixed(1);
    const maRate = ((maAgreementCount / tier1.agreementEvents.length) * 100).toFixed(1);
    const unanimousRate = ((unanimousCount / tier1.agreementEvents.length) * 100).toFixed(1);

    console.log(`Slope Sign Agreement:      ${slopeRate}% (${slopeAgreementCount}/${tier1.agreementEvents.length} ticks)`);
    console.log(`Momentum Composite Agreement: ${momentumRate}% (${momentumAgreementCount}/${tier1.agreementEvents.length} ticks)`);
    console.log(`Moving Average Agreement:  ${maRate}% (${maAgreementCount}/${tier1.agreementEvents.length} ticks)`);
    console.log(`Unanimous (3/3) Agreement: ${unanimousRate}% (${unanimousCount}/${tier1.agreementEvents.length} ticks)\n`);
  } else {
    console.log('No fusion signals detected\n');
  }
}

function printConfidenceAnalysis(tier1: Tier1Stats): void {
  console.log('--- Confidence Score Analysis ---');
  if (tier1.confidenceScores.length > 0) {
    const buyConfidences = tier1.confidenceScores.filter(c => c.signal === TradeSignal.Buy).map(c => c.confidence);
    const sellConfidences = tier1.confidenceScores.filter(c => c.signal === TradeSignal.Sell).map(c => c.confidence);

    if (buyConfidences.length > 0) {
      const minBuy = Math.min(...buyConfidences);
      const maxBuy = Math.max(...buyConfidences);
      const meanBuy = buyConfidences.reduce((sum, c) => sum + c, 0) / buyConfidences.length;
      const sortedBuy = [...buyConfidences].sort((a, b) => a - b);
      const medianBuy = sortedBuy[Math.floor(sortedBuy.length / 2)] ?? 0;

      console.log(`Buy Signals:  min=${minBuy.toFixed(2)}, max=${maxBuy.toFixed(2)}, mean=${meanBuy.toFixed(2)}, median=${medianBuy.toFixed(2)}`);
    }

    if (sellConfidences.length > 0) {
      const minSell = Math.min(...sellConfidences);
      const maxSell = Math.max(...sellConfidences);
      const meanSell = sellConfidences.reduce((sum, c) => sum + c, 0) / sellConfidences.length;
      const sortedSell = [...sellConfidences].sort((a, b) => a - b);
      const medianSell = sortedSell[Math.floor(sortedSell.length / 2)] ?? 0;

      console.log(`Sell Signals: min=${minSell.toFixed(2)}, max=${maxSell.toFixed(2)}, mean=${meanSell.toFixed(2)}, median=${medianSell.toFixed(2)}`);
    }

    const weakSignals = tier1.confidenceScores.filter(c => Math.abs(c.confidence) < 0.7).length;
    const strongSignals = tier1.confidenceScores.filter(c => Math.abs(c.confidence) >= 0.8).length;

    console.log(`\nWeak Signals (<0.70):   ${weakSignals} (${((weakSignals / tier1.confidenceScores.length) * 100).toFixed(1)}%)`);
    console.log(`Strong Signals (≥0.80): ${strongSignals} (${((strongSignals / tier1.confidenceScores.length) * 100).toFixed(1)}%)\n`);
  } else {
    console.log('No confidence data available\n');
  }
}

function printSentimentTiming(tier1: Tier1Stats): void {
  console.log('--- Sentiment-to-Signal Timing ---');
  console.log(`Total Fusion Signal Changes: ${tier1.fusionSignalChanges.length}`);

  if (tier1.fusionSignalChanges.length > 1) {
    const intervals: number[] = [];
    for (let i = 1; i < tier1.fusionSignalChanges.length; i++) {
      const curr = tier1.fusionSignalChanges[i];
      const prev = tier1.fusionSignalChanges[i - 1];
      if (curr && prev) {
        intervals.push(curr.timestamp - prev.timestamp);
      }
    }

    if (intervals.length > 0) {
      const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
      console.log(`Average Time Between Signal Changes: ${(avgInterval / 1000 / 60).toFixed(2)} minutes`);
    }
  }

  console.log('');
}

function printTier1Stats(tier1: Tier1Stats): void {
  console.log('\n=== TIER 1: SIGNAL QUALITY & ANALYSIS ===\n');

  printSignalDurations(tier1);
  printFalsePositives(tier1);
  printAgreementRates(tier1);
  printConfidenceAnalysis(tier1);
  printSentimentTiming(tier1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npm run parse-log -- <controller-directory> [log-filename]');
    console.error('');
    console.error('Examples:');
    console.error('  npm run parse-log -- trade-controller-1_1761756068332_1761756068032');
    console.error('  npm run parse-log -- trade-controller-1_1761756068332_1761756068032 log.log');
    console.error('  npm run parse-log -- trade-controller-1_1761756068332_1761756068032 log-replay-1761937324979.log');
    console.error('');
    console.error('If log-filename is omitted, defaults to "log.log"');
    process.exit(1);
  }

  const controllerDir = args[0];
  if (!controllerDir) {
    console.error('Error: No controller directory provided');
    process.exit(1);
  }

  // Default to log.log if no second argument provided
  const logFileName = args[1] ?? 'log.log';

  // Construct full path: records/trade-manager/trade-controllers/<controllerDir>/<logFileName>
  const logFilePath = path.resolve(
    process.cwd(),
    'records',
    'trade-manager',
    'trade-controllers',
    controllerDir,
    logFileName
  );

  if (!fs.existsSync(logFilePath)) {
    console.error(`Error: Log file not found: ${logFilePath}`);
    console.error('');
    console.error('Make sure the controller directory exists and contains the log file.');
    process.exit(1);
  }

  console.log(`Parsing log file: ${logFilePath}`);
  console.log('');

  const { basic, tier1 } = await parseLogFile(logFilePath);
  
  printBasicStats(basic);
  printTier1Stats(tier1);
}

await main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
