import EventEmitter from 'node:events';
import { TradeController } from './tradeController.js';
import type { TradeControllerOptions } from './core/options.js';

export class TradeManagerService extends EventEmitter {
  private controllers: TradeController[] = [];

  addTradeController(tradeControllerOptions: TradeControllerOptions): TradeController {
    if (!tradeControllerOptions)
      throw new Error('TradeControllerOptions must be provided.');

    const controller = new TradeController(tradeControllerOptions);

    this.controllers.push(controller);

    controller.start();

    return controller;
  }

  removeTradeController(controller: TradeController) {
    controller.stop();

    this.controllers = this.controllers.filter(c => c !== controller);
  }
}
