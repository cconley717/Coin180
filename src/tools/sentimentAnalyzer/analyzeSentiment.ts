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

async function analyzeSentimentLog(logPath: string): Promise<void> {
    const sentimentScores: Array<{ timestamp: number; raw: number; filtered: number }> = [];
    
    const fileStream = fs.createReadStream(logPath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY
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
                    filtered
                });
            }
        } catch {
            continue;
        }
    }

    if (sentimentScores.length === 0) {
        console.log('No sentiment data found');
        return;
    }

    // Calculate statistics
    const rawScores = sentimentScores.map(s => s.raw);
    const filteredScores = sentimentScores.map(s => s.filtered);
    
    const min = Math.min(...rawScores);
    const max = Math.max(...rawScores);
    const avg = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
    
    const filteredMin = Math.min(...filteredScores);
    const filteredMax = Math.max(...filteredScores);
    const filteredAvg = filteredScores.reduce((a, b) => a + b, 0) / filteredScores.length;
    
    // Calculate volatility (standard deviation)
    const variance = rawScores.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / rawScores.length;
    const stdDev = Math.sqrt(variance);
    
    console.log('\n=== Sentiment Score Analysis ===\n');
    console.log('Total ticks:', sentimentScores.length);
    console.log('\nRaw Sentiment Scores:');
    console.log('  Min:', min);
    console.log('  Max:', max);
    console.log('  Average:', avg.toFixed(2));
    console.log('  Std Dev:', stdDev.toFixed(2));
    console.log('  Range:', max - min);
    
    console.log('\nFiltered Sentiment Scores:');
    console.log('  Min:', filteredMin);
    console.log('  Max:', filteredMax);
    console.log('  Average:', filteredAvg.toFixed(2));
    console.log('  Range:', filteredMax - filteredMin);
    
    // Find significant changes
    const changes: Array<{ index: number; from: number; to: number; delta: number }> = [];
    for (let i = 1; i < filteredScores.length; i++) {
        const delta = filteredScores[i]! - filteredScores[i - 1]!;
        if (Math.abs(delta) > stdDev * 0.5) { // Significant if > 0.5 std deviations
            changes.push({
                index: i,
                from: filteredScores[i - 1]!,
                to: filteredScores[i]!,
                delta
            });
        }
    }
    
    console.log('\nSignificant Changes (> 0.5 std dev):');
    console.log('  Count:', changes.length);
    if (changes.length > 0) {
        console.log('  Largest jump:', Math.max(...changes.map(c => Math.abs(c.delta))).toFixed(2));
        console.log('\nTop 10 changes:');
        const sortedChanges = changes.toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10);
        for (let i = 0; i < sortedChanges.length; i++) {
            const c = sortedChanges[i]!;
            console.log(`    ${i + 1}. Tick ${c.index}: ${c.from.toFixed(1)} → ${c.to.toFixed(1)} (${c.delta > 0 ? '+' : ''}${c.delta.toFixed(1)})`);
        }
    }
    
    // Look for oscillation patterns (zero crossings)
    const crossings: number[] = [];
    for (let i = 1; i < filteredScores.length; i++) {
        const prev = filteredScores[i - 1]!;
        const curr = filteredScores[i]!;
        if ((prev < 0 && curr > 0) || (prev > 0 && curr < 0)) {
            crossings.push(i);
        }
    }
    
    console.log('\nZero Crossings (sentiment flips):');
    console.log('  Count:', crossings.length);
    if (crossings.length > 0) {
        console.log('  First 5:');
        const firstFive = crossings.slice(0, 5);
        for (let i = 0; i < firstFive.length; i++) {
            const tick = firstFive[i]!;
            console.log(`    ${i + 1}. Tick ${tick}: ${filteredScores[tick - 1]!.toFixed(1)} → ${filteredScores[tick]!.toFixed(1)}`);
        }
    }
    
    // Window analysis for oscillations
    console.log('\nMoving Window Analysis (20-tick windows):');
    for (let i = 0; i < filteredScores.length - 20; i += 20) {
        const window = filteredScores.slice(i, i + 20);
        const windowMin = Math.min(...window);
        const windowMax = Math.max(...window);
        const windowRange = windowMax - windowMin;
        if (windowRange > stdDev * 1.5) {
            console.log(`  Ticks ${i}-${i + 20}: range ${windowRange.toFixed(1)} (${windowMin.toFixed(1)} to ${windowMax.toFixed(1)})`);
        }
    }
}

const logPath = process.argv[2];
if (!logPath) {
    console.error('Usage: node dist/tools/sentimentAnalyzer/analyzeSentiment.js <log-path>');
    process.exit(1);
}

await analyzeSentimentLog(logPath);
