const assert = require('assert/strict');

(async () => {
  const orderExecutionPath = require.resolve('./orderExecution');
  const httpModulePath = require.resolve('./http');

  const originalHttpModule = require.cache[httpModulePath];
  const originalOrderExecutionModule = require.cache[orderExecutionPath];

  delete require.cache[orderExecutionPath];
  delete require.cache[httpModulePath];

  require.cache[httpModulePath] = {
    id: httpModulePath,
    filename: httpModulePath,
    loaded: true,
    exports: {
      requestJson: async () => ({ json: { id: 'sell-order-1' } }),
      logHttpError: () => {},
    },
  };

  const {
    placeOrderUnified,
    configureOrderExecutionRuntime,
  } = require('./orderExecution');

  const stateTransitions = [];
  configureOrderExecutionRuntime({
    setEngineState: (nextState, payload) => {
      stateTransitions.push({ nextState, payload });
    },
    setLastActionTrace: () => {},
    sleep: async () => {},
  });

  const envSnapshot = {
    APCA_API_KEY_ID: process.env.APCA_API_KEY_ID,
    APCA_API_SECRET_KEY: process.env.APCA_API_SECRET_KEY,
  };
  process.env.APCA_API_KEY_ID = 'key';
  process.env.APCA_API_SECRET_KEY = 'secret';

  try {
    await placeOrderUnified({
      symbol: 'BTC/USD',
      url: 'https://api.alpaca.markets/v2/orders',
      payload: {
        symbol: 'BTC/USD',
        side: 'sell',
        type: 'limit',
        qty: '0.5',
      },
      label: 'orders_submit',
      reason: 'test_exit',
      context: { source: 'test' },
      intent: 'exit',
    });

    const placingSellTransition = stateTransitions.find((event) => event.nextState === 'placing_sell');
    assert.ok(placingSellTransition, 'expected placing_sell transition for successful sell order');
    assert.equal(placingSellTransition.payload?.reason, 'sell_submitted');
    assert.equal(placingSellTransition.payload?.context?.symbol, 'BTC/USD');
  } finally {
    if (envSnapshot.APCA_API_KEY_ID === undefined) delete process.env.APCA_API_KEY_ID;
    else process.env.APCA_API_KEY_ID = envSnapshot.APCA_API_KEY_ID;

    if (envSnapshot.APCA_API_SECRET_KEY === undefined) delete process.env.APCA_API_SECRET_KEY;
    else process.env.APCA_API_SECRET_KEY = envSnapshot.APCA_API_SECRET_KEY;

    delete require.cache[orderExecutionPath];
    delete require.cache[httpModulePath];

    if (originalHttpModule) {
      require.cache[httpModulePath] = originalHttpModule;
    }
    if (originalOrderExecutionModule) {
      require.cache[orderExecutionPath] = originalOrderExecutionModule;
    }
  }

  console.log('order execution tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
