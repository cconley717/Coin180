'use strict';

import app from './app.js';
import { TradeManagerService } from './services/tradeManager/tradeManagerService.js';
import type { TradeControllerOptions } from './services/tradeManager/core/options.js';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server started at http://${HOST}:${PORT}`);

  const tradeManagerService = new TradeManagerService();

  const tradeControllerOptions1: TradeControllerOptions = loadPreset('default');
  const tradeController1 = tradeManagerService.addTradeController(tradeControllerOptions1);

  tradeController1.on('started', (data) => console.log('Started: ', data));
  tradeController1.on('stopped', (data) => console.log('Stopped: ', data));

  tradeController1.on('tick', (data) => {
    console.log('Tick: ', data);
  });

  tradeController1.on('error', (err) => console.error('Error: ', err));
});

function loadPreset(name = 'default'): TradeControllerOptions {
  const file = path.resolve(process.cwd(), `config/presets/${name}.trade-controller.json`);
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

  return JSON.parse(text) as TradeControllerOptions;
}
