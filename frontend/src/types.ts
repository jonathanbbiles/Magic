export type Account = {
  equity?: string | number | null;
  last_equity?: string | number | null;
  portfolio_value?: string | number | null;
  buying_power?: string | number | null;
};

export type Position = {
  symbol?: string | null;
  qty?: string | number | null;
  market_value?: string | number | null;
  unrealized_plpc?: string | number | null;
};

export type Activity = {
  id?: string | null;
  activity_type?: string | null;
  symbol?: string | null;
  side?: string | null;
  qty?: string | number | null;
  price?: string | number | null;
  transaction_time?: string | null;
};

export type StatusResponse = {
  ok?: boolean;
  version?: string | null;
  serverTime?: string | null;
  uptimeSec?: number | null;
  alpaca?: {
    alpacaAuthOk?: boolean;
  };
  diagnostics?: {
    openPositions?: unknown[];
    openOrders?: unknown[];
    lastScanAt?: string | null;
    lastQuoteAt?: string | null;
  };
  lastHttpError?: {
    errorMessage?: string | null;
  } | null;
};
