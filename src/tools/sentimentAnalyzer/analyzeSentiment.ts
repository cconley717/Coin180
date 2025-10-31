import fs from 'node:fs';
import readline from 'node:readline';

interface TickData {
  tick?: {
    timestamp: number;
    heatmapAnalyzer?: {
      result?: {
        sentimentScore?: number;
      };
    };
    deltaFilterAnalyzer?: {
      filteredScore?: number;
    };
  };
}

interface SentimentScore {
  timestamp: number;
  raw: number;
  filtered: number;
}

interface ScoreStatistics {
  min: number;
  max: number;
  avg: number;
  stdDev: number;
  range: number;
}

interface SignificantChange {
  index: number;
  from: number;
  to: number;
  delta: number;
}

async function readSentimentScores(logPath: string): Promise<SentimentScore[]> {
  const sentimentScores: SentimentScore[] = [];

  const fileStream = fs.createReadStream(logPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const data: TickData = JSON.parse(line);
      if (!data.tick) continue;

      const raw = data.tick.heatmapAnalyzer?.result?.sentimentScore;
      const filtered = data.tick.deltaFilterAnalyzer?.filteredScore;

      if (raw !== undefined && filtered !== undefined) {
        sentimentScores.push({
          timestamp: data.tick.timestamp,
          raw,
          filtered,
        });
      }
    } catch {
      continue;
    }
  }

  return sentimentScores;
}

function calculateStatistics(scores: number[]): ScoreStatistics {
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  const variance = scores.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / scores.length;
  const stdDev = Math.sqrt(variance);

  return { min, max, avg, stdDev, range: max - min };
}

function findSignificantChanges(scores: number[], threshold: number): SignificantChange[] {
  const changes: SignificantChange[] = [];

  for (let i = 1; i < scores.length; i++) {
    const delta = scores[i]! - scores[i - 1]!;
    if (Math.abs(delta) > threshold) {
      changes.push({
        index: i,
        from: scores[i - 1]!,
        to: scores[i]!,
        delta,
      });
    }
  }

  return changes;
}

function findZeroCrossings(scores: number[]): number[] {
  const crossings: number[] = [];

  for (let i = 1; i < scores.length; i++) {
    const prev = scores[i - 1]!;
    const curr = scores[i]!;
    if ((prev < 0 && curr > 0) || (prev > 0 && curr < 0)) {
      crossings.push(i);
    }
  }

  return crossings;
}

function printBasicStats(
  sentimentScores: SentimentScore[],
  rawStats: ScoreStatistics,
  filteredStats: ScoreStatistics
): void {
  console.log('\n=== Sentiment Score Analysis ===\n');
  console.log('Total ticks:', sentimentScores.length);

  console.log('\nRaw Sentiment Scores:');
  console.log('  Min:', rawStats.min);
  console.log('  Max:', rawStats.max);
  console.log('  Average:', rawStats.avg.toFixed(2));
  console.log('  Std Dev:', rawStats.stdDev.toFixed(2));
  console.log('  Range:', rawStats.range);

  console.log('\nFiltered Sentiment Scores:');
  console.log('  Min:', filteredStats.min);
  console.log('  Max:', filteredStats.max);
  console.log('  Average:', filteredStats.avg.toFixed(2));
  console.log('  Range:', filteredStats.range);
}

function printSignificantChanges(changes: SignificantChange[]): void {
  console.log('\nSignificant Changes (> 0.5 std dev):');
  console.log('  Count:', changes.length);

  if (changes.length > 0) {
    console.log('  Largest jump:', Math.max(...changes.map(c => Math.abs(c.delta))).toFixed(2));
    console.log('\nTop 10 changes:');
    const sortedChanges = changes.toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10);
    for (let i = 0; i < sortedChanges.length; i++) {
      const c = sortedChanges[i]!;
      console.log(
        `    ${i + 1}. Tick ${c.index}: ${c.from.toFixed(1)} → ${c.to.toFixed(1)} (${c.delta > 0 ? '+' : ''}${c.delta.toFixed(1)})`
      );
    }
  }
}

function printZeroCrossings(crossings: number[], filteredScores: number[]): void {
  console.log('\nZero Crossings (sentiment flips):');
  console.log('  Count:', crossings.length);

  if (crossings.length > 0) {
    console.log('  First 5:');
    const firstFive = crossings.slice(0, 5);
    for (let i = 0; i < firstFive.length; i++) {
      const tick = firstFive[i]!;
      console.log(
        `    ${i + 1}. Tick ${tick}: ${filteredScores[tick - 1]!.toFixed(1)} → ${filteredScores[tick]!.toFixed(1)}`
      );
    }
  }
}

function printMovingWindowAnalysis(filteredScores: number[], stdDev: number): void {
  console.log('\nMoving Window Analysis (20-tick windows):');

  for (let i = 0; i < filteredScores.length - 20; i += 20) {
    const window = filteredScores.slice(i, i + 20);
    const windowMin = Math.min(...window);
    const windowMax = Math.max(...window);
    const windowRange = windowMax - windowMin;

    if (windowRange > stdDev * 1.5) {
      console.log(
        `  Ticks ${i}-${i + 20}: range ${windowRange.toFixed(1)} (${windowMin.toFixed(1)} to ${windowMax.toFixed(1)})`
      );
    }
  }
}

async function analyzeSentimentLog(logPath: string): Promise<void> {
  const sentimentScores = await readSentimentScores(logPath);

  if (sentimentScores.length === 0) {
    console.log('No sentiment data found');
    return;
  }

  const rawScores = sentimentScores.map(s => s.raw);
  const filteredScores = sentimentScores.map(s => s.filtered);

  const rawStats = calculateStatistics(rawScores);
  const filteredStats = calculateStatistics(filteredScores);

  printBasicStats(sentimentScores, rawStats, filteredStats);

  const changes = findSignificantChanges(filteredScores, rawStats.stdDev * 0.5);
  printSignificantChanges(changes);

  const crossings = findZeroCrossings(filteredScores);
  printZeroCrossings(crossings, filteredScores);

  printMovingWindowAnalysis(filteredScores, rawStats.stdDev);
}

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node dist/tools/sentimentAnalyzer/analyzeSentiment.js <log-path>');
  process.exit(1);
}

await analyzeSentimentLog(logPath);
